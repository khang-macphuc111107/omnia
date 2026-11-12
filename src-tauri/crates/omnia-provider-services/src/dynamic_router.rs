//! Deterministic dynamic provider, model, and quota router engine.
//!
//! Implements `docs/workspace/DYNAMIC_ROUTING_REQUIREMENTS.md` over the shared
//! `provider_profiles` and `provider_models` contracts without creating duplicate
//! database schemas or exposing credentials/prompt bodies in receipts.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use omnia_harness::provider::factory::{AdapterFamily, AuthScheme};
use omnia_session_store::error::{NativeError, NativeResult, ProviderErrorClass};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::profiles::provider_profile_from_row;
use crate::routing::{provider_selection, ProviderProfileInput};

pub const ROUTER_RECEIPT_SCHEMA_VERSION: u32 = 1;
pub const ROUTER_REDACTION_POLICY: &str = "strict_no_secrets_no_prompts_no_raw_urls_v1";
const MAX_LATENCY_SAMPLES: usize = 256;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD: u32 = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS: u64 = 30_000;

/// Strict privacy and data-handling boundary ordered from least to most restrictive.
/// A route candidate is eligible only when `candidate.privacy_tier >= policy.privacy_tier`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyTier {
    Public,
    ZeroDataRetention,
    PrivateVpc,
    LocalOnly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskRisk {
    Low,
    Standard,
    High,
    Critical,
}

impl TaskRisk {
    pub fn policy_class(self, privacy: PrivacyTier) -> String {
        let risk = match self {
            Self::Low => "low",
            Self::Standard => "standard",
            Self::High => "high",
            Self::Critical => "critical",
        };
        let tier = match privacy {
            PrivacyTier::Public => "public",
            PrivacyTier::ZeroDataRetention => "zdr",
            PrivacyTier::PrivateVpc => "vpc",
            PrivacyTier::LocalOnly => "local",
        };
        format!("{tier}:{risk}")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FallbackScope {
    None,
    SameProviderOnly,
    SamePrivacyBoundary,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum EmergencyQuotaPolicy {
    Deny,
    AllowEmergencyReserve,
    AllowStaleQuotaWithCap { max_tokens: u64 },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    pub text: bool,
    pub vision: bool,
    pub audio: bool,
    pub tool_use: bool,
    pub structured_output: bool,
    pub streaming: bool,
    pub max_attachments: usize,
}

impl Default for ModelCapabilities {
    fn default() -> Self {
        Self {
            text: true,
            vision: false,
            audio: false,
            tool_use: false,
            structured_output: false,
            streaming: true,
            max_attachments: 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteRequestPolicy {
    pub idempotency_key: String,
    pub required_auth_boundary: String,
    pub required_capabilities: ModelCapabilities,
    pub min_context_tokens: u64,
    pub min_output_tokens: u64,
    pub min_quality_tier: u8,
    pub task_risk: TaskRisk,
    pub privacy_tier: PrivacyTier,
    pub allowed_regions: Vec<String>,
    pub max_retention_hours: Option<u32>,
    pub allow_local_network: bool,
    pub estimated_input_tokens: u64,
    pub estimated_output_tokens: u64,
    pub max_estimated_cost_microunits: Option<u64>,
    pub max_actual_cost_microunits: Option<u64>,
    pub token_budget: Option<u64>,
    pub emergency_policy: EmergencyQuotaPolicy,
    pub deadline_ms: Option<i64>,
    pub max_latency_p95_ms: Option<u64>,
    pub allowed_providers: Vec<String>,
    pub forbidden_providers: Vec<String>,
    pub allowed_models: Vec<String>,
    pub forbidden_models: Vec<String>,
    pub preferred_candidate_ids: Vec<String>,
    pub fallback_scope: FallbackScope,
    pub cancelled: bool,
}

impl RouteRequestPolicy {
    pub fn estimated_total_tokens(&self) -> u64 {
        self.estimated_input_tokens
            .saturating_add(self.estimated_output_tokens)
            .max(1)
    }

    /// Normalize identifiers and lists deterministically without altering user meaning.
    pub fn normalize(mut self) -> NativeResult<Self> {
        self.idempotency_key = self.idempotency_key.trim().to_owned();
        if self.idempotency_key.is_empty() || self.idempotency_key.len() > 256 {
            return Err(NativeError::invalid(
                "idempotencyKey",
                "must be 1..=256 non-whitespace characters",
            ));
        }
        self.required_auth_boundary = self.required_auth_boundary.trim().to_owned();
        if self.required_auth_boundary.is_empty() {
            return Err(NativeError::invalid(
                "requiredAuthBoundary",
                "must identify an explicit profile or workspace boundary",
            ));
        }
        self.allowed_regions = normalize_list(self.allowed_regions, true);
        self.allowed_providers = normalize_list(self.allowed_providers, false);
        self.forbidden_providers = normalize_list(self.forbidden_providers, false);
        self.allowed_models = normalize_list(self.allowed_models, false);
        self.forbidden_models = normalize_list(self.forbidden_models, false);
        self.preferred_candidate_ids = dedup_preserving_order(self.preferred_candidate_ids);
        Ok(self)
    }

    pub fn policy_hash(&self) -> String {
        let canonical = serde_json::to_string(self).unwrap_or_default();
        sha256_hex(canonical.as_bytes())
    }
}

fn normalize_list(values: Vec<String>, lowercase: bool) -> Vec<String> {
    let mut set = BTreeSet::new();
    for item in values {
        let trimmed = item.trim();
        if !trimmed.is_empty() {
            if lowercase {
                set.insert(trimmed.to_ascii_lowercase());
            } else {
                set.insert(trimmed.to_owned());
            }
        }
    }
    set.into_iter().collect()
}

fn dedup_preserving_order(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for item in values {
        let trimmed = item.trim().to_owned();
        if !trimmed.is_empty() && seen.insert(trimmed.clone()) {
            out.push(trimmed);
        }
    }
    out
}

/// Secret-free route candidate metadata. Credential presence is represented strictly
/// as a boolean + opaque revision marker; raw credentials are never stored here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteCandidate {
    pub candidate_id: String,
    pub provider_id: String,
    pub provider_type: String,
    pub model_id: String,
    pub adapter_family: AdapterFamily,
    pub auth_scheme: AuthScheme,
    pub auth_boundary: String,
    pub capabilities: ModelCapabilities,
    pub context_limit_tokens: u64,
    pub max_output_tokens: u64,
    pub quality_tier: u8,
    pub pricing_version: String,
    pub input_cost_per_million_microunits: Option<u64>,
    pub output_cost_per_million_microunits: Option<u64>,
    pub region: String,
    pub privacy_tier: PrivacyTier,
    pub retention_hours: u32,
    pub credential_present: bool,
    pub local_network_endpoint: bool,
    pub local_network_grant: bool,
    pub enabled: bool,
    pub route_priority: i32,
    pub compatibility_notes: Vec<String>,
    pub last_qualification_receipt_id: Option<String>,
}

impl RouteCandidate {
    pub fn estimate_cost_microunits(&self, input_tokens: u64, output_tokens: u64) -> Option<u64> {
        let in_rate = self.input_cost_per_million_microunits?;
        let out_rate = self.output_cost_per_million_microunits?;
        let in_cost = ((input_tokens as u128) * (in_rate as u128)).div_ceil(1_000_000);
        let out_cost = ((output_tokens as u128) * (out_rate as u128)).div_ceil(1_000_000);
        u64::try_from(in_cost.saturating_add(out_cost)).ok()
    }
}

/// Explicit quota state. Unknown, stale, and contradictory states are NEVER silently
/// coerced to zero or full capacity.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QuotaState {
    Known {
        remaining_tokens: u64,
        window_reset_at_ms: i64,
        window_capacity_tokens: Option<u64>,
        window_duration_ms: Option<i64>,
        emergency_reserve_tokens: u64,
    },
    Unknown {
        reason: String,
    },
    Stale {
        last_known_remaining_tokens: u64,
        observed_at_ms: i64,
        stale_since_ms: i64,
        emergency_reserve_tokens: u64,
    },
    Contradictory {
        detail: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CircuitState {
    Closed,
    Open { opened_at_ms: i64, cooldown_ms: u64 },
    HalfOpen { probe_in_flight: bool },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateResourceState {
    pub quota: QuotaState,
    pub reserved_tokens: u64,
    pub reserved_cost_microunits: u64,
    pub reconciled_cost_microunits: u64,
    pub currency: String,
    pub unknown_usage_count: u64,
    pub ewma_latency_ms: Option<f64>,
    pub latency_samples_ms: Vec<u64>,
    pub timeout_count: u64,
    pub error_count: u64,
    pub success_count: u64,
    pub retry_after_until_ms: Option<i64>,
    pub rate_limited_count: u64,
    pub circuit_state: CircuitState,
    pub circuit_failure_threshold: u32,
    pub circuit_cooldown_ms: u64,
    pub consecutive_failures: u32,
    pub circuit_transitions: u64,
    pub last_success_ms: Option<i64>,
    pub last_failure_ms: Option<i64>,
    pub freshness_ms: i64,
    pub max_staleness_ms: Option<i64>,
    pub concurrent_reservations: u32,
    pub max_concurrency: u32,
    pub stale_marker: bool,
}

impl Default for CandidateResourceState {
    fn default() -> Self {
        Self {
            quota: QuotaState::Unknown {
                reason: "uninitialized_quota_snapshot".into(),
            },
            reserved_tokens: 0,
            reserved_cost_microunits: 0,
            reconciled_cost_microunits: 0,
            currency: "USD_MICRO".into(),
            unknown_usage_count: 0,
            ewma_latency_ms: None,
            latency_samples_ms: Vec::new(),
            timeout_count: 0,
            error_count: 0,
            success_count: 0,
            retry_after_until_ms: None,
            rate_limited_count: 0,
            circuit_state: CircuitState::Closed,
            circuit_failure_threshold: DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
            circuit_cooldown_ms: DEFAULT_CIRCUIT_COOLDOWN_MS,
            consecutive_failures: 0,
            circuit_transitions: 0,
            last_success_ms: None,
            last_failure_ms: None,
            freshness_ms: 0,
            max_staleness_ms: None,
            concurrent_reservations: 0,
            max_concurrency: 16,
            stale_marker: false,
        }
    }
}

impl CandidateResourceState {
    pub fn percentile_latency_ms(&self, percentile: usize) -> Option<u64> {
        if self.latency_samples_ms.is_empty() {
            return None;
        }
        let mut sorted = self.latency_samples_ms.clone();
        sorted.sort_unstable();
        let clamped = percentile.clamp(1, 100);
        let idx = ((sorted.len() * clamped).div_ceil(100)).saturating_sub(1);
        sorted.get(idx).copied()
    }

    pub fn p50_latency_ms(&self) -> Option<u64> {
        self.percentile_latency_ms(50)
    }

    pub fn p95_latency_ms(&self) -> Option<u64> {
        self.percentile_latency_ms(95)
    }

    pub fn p99_latency_ms(&self) -> Option<u64> {
        self.percentile_latency_ms(99)
    }

    fn record_latency(&mut self, sample_ms: u64) {
        if self.latency_samples_ms.len() >= MAX_LATENCY_SAMPLES {
            self.latency_samples_ms.remove(0);
        }
        self.latency_samples_ms.push(sample_ms);
        let sample_f = sample_ms as f64;
        self.ewma_latency_ms = Some(match self.ewma_latency_ms {
            Some(prev) => prev * 0.75 + sample_f * 0.25,
            None => sample_f,
        });
    }

    fn advance_time(&mut self, now_ms: i64) {
        if let CircuitState::Open {
            opened_at_ms,
            cooldown_ms,
        } = self.circuit_state
        {
            if now_ms >= opened_at_ms.saturating_add(cooldown_ms as i64) {
                self.circuit_state = CircuitState::HalfOpen {
                    probe_in_flight: false,
                };
                self.circuit_transitions = self.circuit_transitions.saturating_add(1);
            }
        }
        if let Some(until) = self.retry_after_until_ms {
            if now_ms >= until {
                self.retry_after_until_ms = None;
            }
        }
        if let QuotaState::Known {
            remaining_tokens,
            window_reset_at_ms,
            window_capacity_tokens,
            window_duration_ms,
            emergency_reserve_tokens,
        } = &self.quota
        {
            if now_ms >= *window_reset_at_ms {
                match (window_capacity_tokens, window_duration_ms) {
                    (Some(capacity), Some(duration)) if *duration > 0 => {
                        let elapsed = now_ms.saturating_sub(*window_reset_at_ms);
                        let periods = (elapsed / *duration).saturating_add(1);
                        let next_reset =
                            window_reset_at_ms.saturating_add(periods.saturating_mul(*duration));
                        self.quota = QuotaState::Known {
                            remaining_tokens: *capacity,
                            window_reset_at_ms: next_reset,
                            window_capacity_tokens: Some(*capacity),
                            window_duration_ms: Some(*duration),
                            emergency_reserve_tokens: *emergency_reserve_tokens,
                        };
                        self.freshness_ms = now_ms;
                        self.stale_marker = false;
                    }
                    _ => {
                        self.quota = QuotaState::Stale {
                            last_known_remaining_tokens: *remaining_tokens,
                            observed_at_ms: self.freshness_ms,
                            stale_since_ms: *window_reset_at_ms,
                            emergency_reserve_tokens: *emergency_reserve_tokens,
                        };
                        self.stale_marker = true;
                    }
                }
            }
        }
        if let Some(max_staleness) = self.max_staleness_ms {
            if now_ms.saturating_sub(self.freshness_ms) > max_staleness {
                if let QuotaState::Known {
                    remaining_tokens,
                    emergency_reserve_tokens,
                    ..
                } = self.quota
                {
                    self.quota = QuotaState::Stale {
                        last_known_remaining_tokens: remaining_tokens,
                        observed_at_ms: self.freshness_ms,
                        stale_since_ms: self.freshness_ms.saturating_add(max_staleness),
                        emergency_reserve_tokens,
                    };
                }
                self.stale_marker = true;
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectionReason {
    Disabled,
    UnauthorizedBoundary,
    MissingCredential,
    LocalNetworkGrantMissing,
    ForbiddenProviderOrModel,
    NotInAllowedSet,
    PrivacyBoundaryViolation,
    RegionViolation,
    RetentionExceeded,
    MissingCapability(String),
    ContextLimitExceeded,
    OutputLimitExceeded,
    QualityBelowTarget,
    CircuitOpen,
    HalfOpenProbeBusy,
    RetryAfterActive { retry_after_until_ms: i64 },
    ConcurrencyExhausted,
    QuotaUnknown,
    QuotaStale,
    QuotaContradictory,
    QuotaExhausted,
    EmergencyReserveProtected,
    PricingUnknownForBudget,
    EstimatedCostExceeded,
    TokenBudgetExceeded,
    LatencyBudgetExceeded,
    ExcludedPriorAttempt,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedCandidateRecord {
    pub candidate_id: String,
    pub reasons: Vec<RejectionReason>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateScoreBreakdown {
    pub candidate_id: String,
    pub capability_fit_bps: i64,
    pub privacy_fit_bps: i64,
    pub budget_headroom_bps: i64,
    pub latency_health_bps: i64,
    pub reliability_bps: i64,
    pub user_preference_bps: i64,
    pub route_priority_bps: i64,
    pub total_score_bps: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteDecisionReceipt {
    pub schema_version: u32,
    pub sequence_id: u64,
    pub source_revision: String,
    pub redaction_policy: String,
    pub idempotency_key_hash: String,
    pub policy_class: String,
    pub policy_hash: String,
    pub candidate_snapshot_hashes: BTreeMap<String, String>,
    pub score_breakdown: Vec<CandidateScoreBreakdown>,
    pub selected_candidate_id: Option<String>,
    pub rejected_candidates: Vec<RejectedCandidateRecord>,
    pub reservation_id: Option<String>,
    pub reserved_tokens: u64,
    pub estimated_cost_microunits: Option<u64>,
    pub deadline_ms: Option<i64>,
    pub decided_at_ms: i64,
    pub is_fallback: bool,
    pub parent_reservation_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptanceState {
    NotSent,
    Accepted,
    Unknown,
}

impl AcceptanceState {
    pub const fn as_storage_str(self) -> &'static str {
        match self {
            Self::NotSent => "false",
            Self::Accepted => "true",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ObservedUsage {
    Known {
        input_tokens: u64,
        output_tokens: u64,
    },
    UsageUnknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ObservedCost {
    Known { microunits: u64 },
    ComputeFromPricing,
    CostUnknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReservationStatus {
    ReservedNotDispatched,
    InFlight,
    ReconciledCharged,
    ReconciledReleased,
    ReconciledUnknownUsage,
    OperatorRecoveryRequired,
    OrphanedOnRestart,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReservationGrant {
    pub reservation_id: String,
    pub candidate_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub generation_epoch: u64,
    pub reserved_tokens: u64,
    pub estimated_cost_microunits: Option<u64>,
    pub idempotent_replay: bool,
    pub decision_receipt: RouteDecisionReceipt,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptGrant {
    pub attempt_id: String,
    pub reservation_id: String,
    pub candidate_id: String,
    pub ordinal: u32,
    pub generation_epoch: u64,
    pub started_at_ms: i64,
}

#[derive(Clone, Debug)]
pub struct OutcomeInput {
    pub reservation_id: String,
    pub attempt_id: String,
    pub generation_epoch: u64,
    pub response_class: Option<ProviderErrorClass>,
    pub accepted_by_provider: AcceptanceState,
    pub observed_usage: ObservedUsage,
    pub actual_cost: ObservedCost,
    pub latency_ms: Option<u64>,
    pub retry_after_ms: Option<u64>,
    pub cancelled: bool,
    pub client_disconnected: bool,
    pub partial_stream: bool,
    pub now_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconcileStatus {
    Charged,
    ReleasedWithoutCharge,
    ChargedWithUnknownUsage,
    OperatorRecoveryRequired,
    FencedDuplicateOrSuperseded,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteOutcomeReceipt {
    pub schema_version: u32,
    pub sequence_id: u64,
    pub source_revision: String,
    pub redaction_policy: String,
    pub reservation_id: String,
    pub decision_sequence_id: u64,
    pub attempt_id: String,
    pub candidate_id: String,
    pub generation_epoch: u64,
    #[serde(with = "opt_provider_error_class")]
    pub response_class: Option<ProviderErrorClass>,
    pub accepted_by_provider: AcceptanceState,
    pub observed_usage: ObservedUsage,
    pub reconciled_cost_microunits: Option<u64>,
    pub cost_unknown: bool,
    pub latency_ms: Option<u64>,
    pub retry_after_ms: Option<u64>,
    pub cancelled: bool,
    pub client_disconnected: bool,
    pub partial_stream: bool,
    pub reconcile_status: ReconcileStatus,
    pub reserved_tokens_released: u64,
    pub tokens_charged: Option<u64>,
    pub recorded_at_ms: i64,
}

mod opt_provider_error_class {
    use omnia_session_store::error::ProviderErrorClass;
    use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(
        value: &Option<ProviderErrorClass>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        value.serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<ProviderErrorClass>, D::Error> {
        let raw = Option::<String>::deserialize(deserializer)?;
        match raw.as_deref() {
            None => Ok(None),
            Some("authentication") => Ok(Some(ProviderErrorClass::Authentication)),
            Some("authorization") => Ok(Some(ProviderErrorClass::Authorization)),
            Some("billing") => Ok(Some(ProviderErrorClass::Billing)),
            Some("rate-limit") => Ok(Some(ProviderErrorClass::RateLimit)),
            Some("quota") => Ok(Some(ProviderErrorClass::Quota)),
            Some("dns") => Ok(Some(ProviderErrorClass::Dns)),
            Some("tls") => Ok(Some(ProviderErrorClass::Tls)),
            Some("transport") => Ok(Some(ProviderErrorClass::Transport)),
            Some("timeout") => Ok(Some(ProviderErrorClass::Timeout)),
            Some("protocol") => Ok(Some(ProviderErrorClass::Protocol)),
            Some("schema") => Ok(Some(ProviderErrorClass::Schema)),
            Some("model-unavailable") => Ok(Some(ProviderErrorClass::ModelUnavailable)),
            Some("content-policy") => Ok(Some(ProviderErrorClass::ContentPolicy)),
            Some("cancelled") => Ok(Some(ProviderErrorClass::Cancelled)),
            Some("unknown") => Ok(Some(ProviderErrorClass::Unknown)),
            Some(other) => Err(D::Error::custom(format!(
                "unknown ProviderErrorClass `{other}`"
            ))),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileResult {
    pub status: ReconcileStatus,
    pub reservation_status: ReservationStatus,
    pub outcome_receipt: RouteOutcomeReceipt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RetryAdmission {
    ReuseAfterPreProviderRelease { new_idempotency_key: String },
    ExplicitNewReservation { new_idempotency_key: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperatorResolution {
    ConfirmNotExecutedRelease,
    ConfirmExecutedCharge {
        actual_tokens: Option<u64>,
        actual_cost_microunits: Option<u64>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveReservation {
    reservation_id: String,
    idempotency_key: String,
    policy: RouteRequestPolicy,
    policy_hash: String,
    candidate_id: String,
    provider_id: String,
    model_id: String,
    pricing_version_at_reservation: String,
    privacy_tier_at_reservation: PrivacyTier,
    auth_boundary_at_reservation: String,
    reserved_tokens: u64,
    reserved_cost_microunits: u64,
    estimated_cost_microunits: Option<u64>,
    used_half_open_probe: bool,
    generation_epoch: u64,
    decision_sequence_id: u64,
    created_at_ms: i64,
    updated_at_ms: i64,
    status: ReservationStatus,
    prior_candidates: Vec<String>,
    attempt_count: u32,
    active_attempt_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteClassTelemetry {
    pub provider_id: String,
    pub model_id: String,
    pub policy_class: String,
    pub reservation_successes: u64,
    pub reservation_failures: u64,
    pub stale_state_rejections: u64,
    pub privacy_boundary_rejections: u64,
    pub estimated_tokens_total: u64,
    pub actual_tokens_total: u64,
    pub unknown_usage_outcomes: u64,
    pub estimated_cost_microunits_total: u64,
    pub actual_cost_microunits_total: u64,
    pub unknown_cost_outcomes: u64,
    pub timeouts: u64,
    pub errors: u64,
    pub retry_after_events: u64,
    pub fallbacks_triggered: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateLatencyReport {
    pub candidate_id: String,
    pub p50_ms: Option<u64>,
    pub p95_ms: Option<u64>,
    pub p99_ms: Option<u64>,
    pub ewma_ms: Option<f64>,
    pub circuit_state: CircuitState,
    pub circuit_transitions: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterMetricsReport {
    pub generated_at_ms: i64,
    pub by_route_and_policy: Vec<RouteClassTelemetry>,
    pub candidate_latencies: Vec<CandidateLatencyReport>,
    pub orphaned_reservations: usize,
    pub operator_recovery_required: usize,
    pub in_flight_unreconciled: usize,
    pub max_recovery_age_ms: u64,
    pub fenced_late_outcomes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterRecoverySnapshot {
    pub schema_version: u32,
    pub source_revision: String,
    pub next_sequence_id: u64,
    pub next_epoch: u64,
    pub candidates: BTreeMap<String, RouteCandidate>,
    pub resources: BTreeMap<String, CandidateResourceState>,
    reservations: BTreeMap<String, ActiveReservation>,
    pub idempotency_index: BTreeMap<String, String>,
    pub decision_receipts: Vec<RouteDecisionReceipt>,
    pub outcome_receipts: Vec<RouteOutcomeReceipt>,
    pub telemetry: BTreeMap<String, RouteClassTelemetry>,
    pub fenced_late_outcomes: u64,
}

struct RouterLedger {
    source_revision: String,
    next_sequence_id: u64,
    next_epoch: u64,
    candidates: BTreeMap<String, RouteCandidate>,
    resources: BTreeMap<String, CandidateResourceState>,
    reservations: BTreeMap<String, ActiveReservation>,
    idempotency_index: BTreeMap<String, String>,
    decision_receipts: Vec<RouteDecisionReceipt>,
    outcome_receipts: Vec<RouteOutcomeReceipt>,
    telemetry: BTreeMap<String, RouteClassTelemetry>,
    fenced_late_outcomes: u64,
}

/// Thread-safe, deterministic dynamic routing and quota-reconciliation engine.
pub struct DynamicRouterEngine {
    inner: Mutex<RouterLedger>,
}

impl DynamicRouterEngine {
    pub fn new(source_revision: impl Into<String>) -> Self {
        Self {
            inner: Mutex::new(RouterLedger {
                source_revision: source_revision.into(),
                next_sequence_id: 1,
                next_epoch: 1,
                candidates: BTreeMap::new(),
                resources: BTreeMap::new(),
                reservations: BTreeMap::new(),
                idempotency_index: BTreeMap::new(),
                decision_receipts: Vec::new(),
                outcome_receipts: Vec::new(),
                telemetry: BTreeMap::new(),
                fenced_late_outcomes: 0,
            }),
        }
    }

    pub fn upsert_candidate(
        &self,
        candidate: RouteCandidate,
        resource: CandidateResourceState,
    ) -> NativeResult<()> {
        if candidate.candidate_id.trim().is_empty()
            || candidate.provider_id.trim().is_empty()
            || candidate.model_id.trim().is_empty()
        {
            return Err(NativeError::invalid(
                "candidate",
                "requires non-empty candidateId, providerId, and modelId",
            ));
        }
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let id = candidate.candidate_id.clone();
        guard.candidates.insert(id.clone(), candidate);
        guard.resources.insert(id, resource);
        Ok(())
    }

    pub fn update_candidate_metadata(&self, candidate: RouteCandidate) -> NativeResult<()> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if !guard.candidates.contains_key(&candidate.candidate_id) {
            return Err(NativeError::new(
                "route_candidate_missing",
                "Cannot update an unregistered route candidate",
            ));
        }
        guard
            .candidates
            .insert(candidate.candidate_id.clone(), candidate);
        Ok(())
    }

    pub fn update_quota(&self, candidate_id: &str, quota: QuotaState, observed_at_ms: i64) -> bool {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(res) = guard.resources.get_mut(candidate_id) {
            res.stale_marker = matches!(
                quota,
                QuotaState::Stale { .. } | QuotaState::Contradictory { .. }
            );
            res.quota = quota;
            res.freshness_ms = observed_at_ms;
            true
        } else {
            false
        }
    }

    pub fn select_and_reserve(
        &self,
        policy: RouteRequestPolicy,
        now_ms: i64,
    ) -> NativeResult<ReservationGrant> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        Self::select_and_reserve_locked(&mut guard, policy, now_ms, false, None, Vec::new())
    }

    fn select_and_reserve_locked(
        ledger: &mut RouterLedger,
        raw_policy: RouteRequestPolicy,
        now_ms: i64,
        is_fallback: bool,
        parent_reservation_id: Option<String>,
        excluded_candidates: Vec<String>,
    ) -> NativeResult<ReservationGrant> {
        if raw_policy.cancelled {
            return Err(NativeError::new(
                "request_cancelled",
                "Cannot select or reserve a route for a cancelled request",
            ));
        }
        let policy = raw_policy.normalize()?;
        let policy_hash = policy.policy_hash();
        let policy_class = policy.task_risk.policy_class(policy.privacy_tier);

        // Idempotent duplicate check before evaluating or charging a second reservation.
        if let Some(existing_res_id) = ledger
            .idempotency_index
            .get(&policy.idempotency_key)
            .cloned()
        {
            if let Some(existing) = ledger.reservations.get(&existing_res_id).cloned() {
                if existing.policy_hash != policy_hash {
                    return Err(NativeError::invalid(
                        "idempotencyKey",
                        "was already bound to a different request policy",
                    ));
                }
                let decision_receipt = ledger
                    .decision_receipts
                    .iter()
                    .find(|r| r.sequence_id == existing.decision_sequence_id)
                    .cloned()
                    .ok_or_else(|| {
                        NativeError::new(
                            "router_ledger_corrupt",
                            "Existing reservation decision receipt is missing",
                        )
                    })?;
                return Ok(ReservationGrant {
                    reservation_id: existing.reservation_id,
                    candidate_id: existing.candidate_id,
                    provider_id: existing.provider_id,
                    model_id: existing.model_id,
                    generation_epoch: existing.generation_epoch,
                    reserved_tokens: existing.reserved_tokens,
                    estimated_cost_microunits: existing.estimated_cost_microunits,
                    idempotent_replay: true,
                    decision_receipt,
                });
            }
        }

        for res in ledger.resources.values_mut() {
            res.advance_time(now_ms);
        }

        let mut snapshot_hashes = BTreeMap::new();
        let mut rejected = Vec::new();
        let mut scored = Vec::new();
        let needed_tokens = policy.estimated_total_tokens();
        let excluded_set: BTreeSet<&str> = excluded_candidates.iter().map(String::as_str).collect();

        let candidate_ids: Vec<String> = ledger.candidates.keys().cloned().collect();
        for cid in candidate_ids {
            let candidate = ledger.candidates[&cid].clone();
            let resource = ledger.resources.get(&cid).cloned().unwrap_or_default();
            let snap_json = serde_json::json!({
                "candidate": &candidate,
                "resource": &resource,
            });
            snapshot_hashes.insert(cid.clone(), sha256_hex(snap_json.to_string().as_bytes()));

            let reasons = evaluate_candidate_eligibility(
                &policy,
                &candidate,
                &resource,
                needed_tokens,
                now_ms,
                excluded_set.contains(cid.as_str()),
            );

            if !reasons.is_empty() {
                let telem = telemetry_entry(
                    &mut ledger.telemetry,
                    &candidate.provider_id,
                    &candidate.model_id,
                    &policy_class,
                );
                if reasons.iter().any(|r| {
                    matches!(
                        r,
                        RejectionReason::QuotaStale | RejectionReason::QuotaUnknown
                    )
                }) {
                    telem.stale_state_rejections = telem.stale_state_rejections.saturating_add(1);
                }
                if reasons.iter().any(|r| {
                    matches!(
                        r,
                        RejectionReason::PrivacyBoundaryViolation
                            | RejectionReason::RegionViolation
                            | RejectionReason::RetentionExceeded
                            | RejectionReason::UnauthorizedBoundary
                    )
                }) {
                    telem.privacy_boundary_rejections =
                        telem.privacy_boundary_rejections.saturating_add(1);
                }
                rejected.push(RejectedCandidateRecord {
                    candidate_id: cid,
                    reasons,
                });
                continue;
            }

            let breakdown = score_candidate(&policy, &candidate, &resource, needed_tokens);
            scored.push((candidate, breakdown));
        }

        // Deterministic sort: highest score first, ties broken by ascending stable candidate_id.
        scored.sort_by(|(ca, sa), (cb, sb)| {
            sb.total_score_bps
                .cmp(&sa.total_score_bps)
                .then_with(|| ca.candidate_id.cmp(&cb.candidate_id))
        });

        let score_breakdown: Vec<CandidateScoreBreakdown> =
            scored.iter().map(|(_, s)| s.clone()).collect();

        let seq_id = ledger.next_sequence_id;
        ledger.next_sequence_id = ledger.next_sequence_id.saturating_add(1);
        let idem_hash = sha256_hex(policy.idempotency_key.as_bytes());

        let Some((winner, _)) = scored.first().cloned() else {
            for r in &rejected {
                if let Some(c) = ledger.candidates.get(&r.candidate_id) {
                    let telem = telemetry_entry(
                        &mut ledger.telemetry,
                        &c.provider_id,
                        &c.model_id,
                        &policy_class,
                    );
                    telem.reservation_failures = telem.reservation_failures.saturating_add(1);
                }
            }
            let receipt = RouteDecisionReceipt {
                schema_version: ROUTER_RECEIPT_SCHEMA_VERSION,
                sequence_id: seq_id,
                source_revision: ledger.source_revision.clone(),
                redaction_policy: ROUTER_REDACTION_POLICY.to_owned(),
                idempotency_key_hash: idem_hash,
                policy_class,
                policy_hash,
                candidate_snapshot_hashes: snapshot_hashes,
                score_breakdown,
                selected_candidate_id: None,
                rejected_candidates: rejected.clone(),
                reservation_id: None,
                reserved_tokens: 0,
                estimated_cost_microunits: None,
                deadline_ms: policy.deadline_ms,
                decided_at_ms: now_ms,
                is_fallback,
                parent_reservation_id,
            };
            ledger.decision_receipts.push(receipt);
            return Err(classify_no_route_error(&rejected));
        };

        let estimated_cost = winner.estimate_cost_microunits(
            policy.estimated_input_tokens,
            policy.estimated_output_tokens,
        );
        let reserved_cost = estimated_cost.unwrap_or(0);
        let reservation_id = format!("resv_{}", Uuid::new_v4().simple());
        let epoch = ledger.next_epoch;
        ledger.next_epoch = ledger.next_epoch.saturating_add(1);

        let mut used_half_open_probe = false;
        if let Some(res) = ledger.resources.get_mut(&winner.candidate_id) {
            res.reserved_tokens = res.reserved_tokens.saturating_add(needed_tokens);
            res.reserved_cost_microunits =
                res.reserved_cost_microunits.saturating_add(reserved_cost);
            res.concurrent_reservations = res.concurrent_reservations.saturating_add(1);
            if matches!(
                res.circuit_state,
                CircuitState::HalfOpen {
                    probe_in_flight: false
                }
            ) {
                res.circuit_state = CircuitState::HalfOpen {
                    probe_in_flight: true,
                };
                used_half_open_probe = true;
            }
        }

        let telem = telemetry_entry(
            &mut ledger.telemetry,
            &winner.provider_id,
            &winner.model_id,
            &policy_class,
        );
        telem.reservation_successes = telem.reservation_successes.saturating_add(1);
        telem.estimated_tokens_total = telem.estimated_tokens_total.saturating_add(needed_tokens);
        if let Some(cost) = estimated_cost {
            telem.estimated_cost_microunits_total =
                telem.estimated_cost_microunits_total.saturating_add(cost);
        }
        if is_fallback {
            telem.fallbacks_triggered = telem.fallbacks_triggered.saturating_add(1);
        }

        let receipt = RouteDecisionReceipt {
            schema_version: ROUTER_RECEIPT_SCHEMA_VERSION,
            sequence_id: seq_id,
            source_revision: ledger.source_revision.clone(),
            redaction_policy: ROUTER_REDACTION_POLICY.to_owned(),
            idempotency_key_hash: idem_hash,
            policy_class,
            policy_hash: policy_hash.clone(),
            candidate_snapshot_hashes: snapshot_hashes,
            score_breakdown,
            selected_candidate_id: Some(winner.candidate_id.clone()),
            rejected_candidates: rejected,
            reservation_id: Some(reservation_id.clone()),
            reserved_tokens: needed_tokens,
            estimated_cost_microunits: estimated_cost,
            deadline_ms: policy.deadline_ms,
            decided_at_ms: now_ms,
            is_fallback,
            parent_reservation_id,
        };
        ledger.decision_receipts.push(receipt.clone());

        let mut prior = excluded_candidates;
        prior.push(winner.candidate_id.clone());

        let active = ActiveReservation {
            reservation_id: reservation_id.clone(),
            idempotency_key: policy.idempotency_key.clone(),
            policy,
            policy_hash,
            candidate_id: winner.candidate_id.clone(),
            provider_id: winner.provider_id.clone(),
            model_id: winner.model_id.clone(),
            pricing_version_at_reservation: winner.pricing_version.clone(),
            privacy_tier_at_reservation: winner.privacy_tier,
            auth_boundary_at_reservation: winner.auth_boundary.clone(),
            reserved_tokens: needed_tokens,
            reserved_cost_microunits: reserved_cost,
            estimated_cost_microunits: estimated_cost,
            used_half_open_probe,
            generation_epoch: epoch,
            decision_sequence_id: seq_id,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            status: ReservationStatus::ReservedNotDispatched,
            prior_candidates: prior,
            attempt_count: 0,
            active_attempt_id: None,
        };
        ledger
            .idempotency_index
            .insert(active.idempotency_key.clone(), reservation_id.clone());
        ledger.reservations.insert(reservation_id.clone(), active);

        Ok(ReservationGrant {
            reservation_id,
            candidate_id: winner.candidate_id,
            provider_id: winner.provider_id,
            model_id: winner.model_id,
            generation_epoch: epoch,
            reserved_tokens: needed_tokens,
            estimated_cost_microunits: estimated_cost,
            idempotent_replay: false,
            decision_receipt: receipt,
        })
    }

    /// Begin a fenced provider dispatch attempt for an admitted reservation.
    /// Verifies that registry state (enabled, pricing revision, privacy, auth boundary)
    /// has not drifted since reservation; if invalidated, cleanly releases the reservation.
    pub fn begin_attempt(&self, reservation_id: &str, now_ms: i64) -> NativeResult<AttemptGrant> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let reservation = guard
            .reservations
            .get(reservation_id)
            .cloned()
            .ok_or_else(|| {
                NativeError::new("reservation_missing", "Route reservation not found")
            })?;

        match reservation.status {
            ReservationStatus::ReservedNotDispatched => {}
            ReservationStatus::InFlight => {
                return Err(NativeError::new(
                    "attempt_already_in_flight",
                    "An active dispatch attempt is already in flight for this reservation",
                ))
            }
            ReservationStatus::OperatorRecoveryRequired | ReservationStatus::OrphanedOnRestart => {
                return Err(NativeError::new(
                    "recovery_required_before_dispatch",
                    "Reservation has an unresolved remote outcome requiring operator recovery",
                ))
            }
            _ => {
                return Err(NativeError::new(
                    "reservation_already_reconciled",
                    "Cannot dispatch on a reservation that has already been reconciled",
                ))
            }
        }

        if let Some(deadline) = reservation.policy.deadline_ms {
            if now_ms > deadline {
                release_in_flight_hold(&mut guard, &reservation);
                if let Some(r) = guard.reservations.get_mut(reservation_id) {
                    r.status = ReservationStatus::ReconciledReleased;
                    r.updated_at_ms = now_ms;
                }
                return Err(NativeError::new(
                    "deadline_exceeded_before_dispatch",
                    "Request deadline expired before provider dispatch started",
                ));
            }
        }

        let current_candidate = guard.candidates.get(&reservation.candidate_id).cloned();
        let drifted = match current_candidate {
            None => true,
            Some(ref c) => {
                !c.enabled
                    || c.pricing_version != reservation.pricing_version_at_reservation
                    || c.privacy_tier < reservation.privacy_tier_at_reservation
                    || c.auth_boundary != reservation.auth_boundary_at_reservation
            }
        };
        if drifted {
            release_in_flight_hold(&mut guard, &reservation);
            if let Some(r) = guard.reservations.get_mut(reservation_id) {
                r.status = ReservationStatus::ReconciledReleased;
                r.updated_at_ms = now_ms;
            }
            return Err(NativeError::new(
                "candidate_invalidated_after_reservation",
                "Selected model was disabled or its registry/pricing revision changed before dispatch",
            ));
        }

        let attempt_id = format!("att_{}", Uuid::new_v4().simple());
        let r = guard.reservations.get_mut(reservation_id).unwrap();
        r.attempt_count = r.attempt_count.saturating_add(1);
        r.active_attempt_id = Some(attempt_id.clone());
        r.status = ReservationStatus::InFlight;
        r.updated_at_ms = now_ms;

        Ok(AttemptGrant {
            attempt_id,
            reservation_id: reservation_id.to_owned(),
            candidate_id: r.candidate_id.clone(),
            ordinal: r.attempt_count,
            generation_epoch: r.generation_epoch,
            started_at_ms: now_ms,
        })
    }

    /// Reconcile a reservation outcome at most once. Late or duplicate outcomes from
    /// superseded epochs or already-reconciled runs are fenced without mutating quota.
    pub fn reconcile_outcome(&self, input: OutcomeInput) -> NativeResult<ReconcileResult> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let Some(reservation) = guard.reservations.get(&input.reservation_id).cloned() else {
            return Err(NativeError::new(
                "reservation_missing",
                "Cannot reconcile an unknown route reservation",
            ));
        };

        let seq_id = guard.next_sequence_id;
        guard.next_sequence_id = guard.next_sequence_id.saturating_add(1);

        let epoch_mismatch = input.generation_epoch != reservation.generation_epoch;
        let attempt_mismatch =
            reservation.active_attempt_id.as_deref() != Some(input.attempt_id.as_str());
        let already_terminal = matches!(
            reservation.status,
            ReservationStatus::ReconciledCharged
                | ReservationStatus::ReconciledReleased
                | ReservationStatus::ReconciledUnknownUsage
        );

        if epoch_mismatch || attempt_mismatch || already_terminal {
            guard.fenced_late_outcomes = guard.fenced_late_outcomes.saturating_add(1);
            let receipt = RouteOutcomeReceipt {
                schema_version: ROUTER_RECEIPT_SCHEMA_VERSION,
                sequence_id: seq_id,
                source_revision: guard.source_revision.clone(),
                redaction_policy: ROUTER_REDACTION_POLICY.to_owned(),
                reservation_id: input.reservation_id,
                decision_sequence_id: reservation.decision_sequence_id,
                attempt_id: input.attempt_id,
                candidate_id: reservation.candidate_id,
                generation_epoch: input.generation_epoch,
                response_class: input.response_class,
                accepted_by_provider: input.accepted_by_provider,
                observed_usage: input.observed_usage,
                reconciled_cost_microunits: None,
                cost_unknown: true,
                latency_ms: input.latency_ms,
                retry_after_ms: input.retry_after_ms,
                cancelled: input.cancelled,
                client_disconnected: input.client_disconnected,
                partial_stream: input.partial_stream,
                reconcile_status: ReconcileStatus::FencedDuplicateOrSuperseded,
                reserved_tokens_released: 0,
                tokens_charged: None,
                recorded_at_ms: input.now_ms,
            };
            guard.outcome_receipts.push(receipt.clone());
            return Ok(ReconcileResult {
                status: ReconcileStatus::FencedDuplicateOrSuperseded,
                reservation_status: reservation.status,
                outcome_receipt: receipt,
            });
        }

        let policy_class = reservation
            .policy
            .task_risk
            .policy_class(reservation.policy.privacy_tier);
        let candidate = guard.candidates.get(&reservation.candidate_id).cloned();

        // Update health, latency, retry-after, and circuit breaker before releasing/charging.
        let is_failure = input.response_class.is_some()
            || matches!(input.accepted_by_provider, AcceptanceState::Unknown);
        if let Some(res) = guard.resources.get_mut(&reservation.candidate_id) {
            if let Some(lat) = input.latency_ms {
                res.record_latency(lat);
            }
            if let Some(ra_ms) = input.retry_after_ms {
                res.retry_after_until_ms = Some(input.now_ms.saturating_add(ra_ms as i64));
                res.rate_limited_count = res.rate_limited_count.saturating_add(1);
            }
            match input.response_class {
                None if matches!(input.accepted_by_provider, AcceptanceState::Accepted)
                    && !input.cancelled
                    && !input.client_disconnected =>
                {
                    res.success_count = res.success_count.saturating_add(1);
                    res.consecutive_failures = 0;
                    res.last_success_ms = Some(input.now_ms);
                    if matches!(res.circuit_state, CircuitState::HalfOpen { .. }) {
                        res.circuit_state = CircuitState::Closed;
                        res.circuit_transitions = res.circuit_transitions.saturating_add(1);
                    }
                }
                Some(ProviderErrorClass::Cancelled) => {
                    if matches!(res.circuit_state, CircuitState::HalfOpen { .. }) {
                        res.circuit_state = CircuitState::HalfOpen {
                            probe_in_flight: false,
                        };
                    }
                }
                Some(class) => {
                    res.error_count = res.error_count.saturating_add(1);
                    if class == ProviderErrorClass::Timeout {
                        res.timeout_count = res.timeout_count.saturating_add(1);
                    }
                    res.last_failure_ms = Some(input.now_ms);
                    let circuit_worthy = matches!(
                        class,
                        ProviderErrorClass::Timeout
                            | ProviderErrorClass::Transport
                            | ProviderErrorClass::Dns
                            | ProviderErrorClass::Tls
                            | ProviderErrorClass::RateLimit
                            | ProviderErrorClass::ModelUnavailable
                            | ProviderErrorClass::Unknown
                    );
                    if circuit_worthy {
                        res.consecutive_failures = res.consecutive_failures.saturating_add(1);
                        let trip = matches!(res.circuit_state, CircuitState::HalfOpen { .. })
                            || res.consecutive_failures >= res.circuit_failure_threshold;
                        if trip && !matches!(res.circuit_state, CircuitState::Open { .. }) {
                            let cooldown = input
                                .retry_after_ms
                                .unwrap_or(res.circuit_cooldown_ms)
                                .max(res.circuit_cooldown_ms);
                            res.circuit_state = CircuitState::Open {
                                opened_at_ms: input.now_ms,
                                cooldown_ms: cooldown,
                            };
                            res.circuit_transitions = res.circuit_transitions.saturating_add(1);
                        }
                    } else if matches!(res.circuit_state, CircuitState::HalfOpen { .. }) {
                        res.circuit_state = CircuitState::HalfOpen {
                            probe_in_flight: false,
                        };
                    }
                }
                None => {
                    if matches!(res.circuit_state, CircuitState::HalfOpen { .. }) {
                        res.circuit_state = CircuitState::HalfOpen {
                            probe_in_flight: false,
                        };
                    }
                }
            }
        }

        {
            let telem = telemetry_entry(
                &mut guard.telemetry,
                &reservation.provider_id,
                &reservation.model_id,
                &policy_class,
            );
            if input.response_class == Some(ProviderErrorClass::Timeout) {
                telem.timeouts = telem.timeouts.saturating_add(1);
            }
            if is_failure && input.response_class != Some(ProviderErrorClass::Cancelled) {
                telem.errors = telem.errors.saturating_add(1);
            }
            if input.retry_after_ms.is_some() {
                telem.retry_after_events = telem.retry_after_events.saturating_add(1);
            }
        }

        // Case A: Remote outcome is explicitly unknown (e.g. socket drop after write).
        // Keep reservation hold active under OperatorRecoveryRequired so quota cannot
        // be silently double-spent!
        if matches!(input.accepted_by_provider, AcceptanceState::Unknown) {
            if let Some(r) = guard.reservations.get_mut(&input.reservation_id) {
                r.status = ReservationStatus::OperatorRecoveryRequired;
                r.updated_at_ms = input.now_ms;
            }
            let receipt = RouteOutcomeReceipt {
                schema_version: ROUTER_RECEIPT_SCHEMA_VERSION,
                sequence_id: seq_id,
                source_revision: guard.source_revision.clone(),
                redaction_policy: ROUTER_REDACTION_POLICY.to_owned(),
                reservation_id: input.reservation_id,
                decision_sequence_id: reservation.decision_sequence_id,
                attempt_id: input.attempt_id,
                candidate_id: reservation.candidate_id,
                generation_epoch: input.generation_epoch,
                response_class: input.response_class,
                accepted_by_provider: AcceptanceState::Unknown,
                observed_usage: ObservedUsage::UsageUnknown,
                reconciled_cost_microunits: None,
                cost_unknown: true,
                latency_ms: input.latency_ms,
                retry_after_ms: input.retry_after_ms,
                cancelled: input.cancelled,
                client_disconnected: input.client_disconnected,
                partial_stream: input.partial_stream,
                reconcile_status: ReconcileStatus::OperatorRecoveryRequired,
                reserved_tokens_released: 0,
                tokens_charged: None,
                recorded_at_ms: input.now_ms,
            };
            guard.outcome_receipts.push(receipt.clone());
            return Ok(ReconcileResult {
                status: ReconcileStatus::OperatorRecoveryRequired,
                reservation_status: ReservationStatus::OperatorRecoveryRequired,
                outcome_receipt: receipt,
            });
        }

        // Release in-flight reservation hold exactly once.
        release_in_flight_hold(&mut guard, &reservation);

        // Case B: Request never reached provider execution (`NotSent`), release without charge.
        if matches!(input.accepted_by_provider, AcceptanceState::NotSent) {
            if let Some(r) = guard.reservations.get_mut(&input.reservation_id) {
                r.status = ReservationStatus::ReconciledReleased;
                r.updated_at_ms = input.now_ms;
            }
            let receipt = RouteOutcomeReceipt {
                schema_version: ROUTER_RECEIPT_SCHEMA_VERSION,
                sequence_id: seq_id,
                source_revision: guard.source_revision.clone(),
                redaction_policy: ROUTER_REDACTION_POLICY.to_owned(),
                reservation_id: input.reservation_id,
                decision_sequence_id: reservation.decision_sequence_id,
                attempt_id: input.attempt_id,
                candidate_id: reservation.candidate_id,
                generation_epoch: input.generation_epoch,
                response_class: input.response_class,
                accepted_by_provider: AcceptanceState::NotSent,
                observed_usage: input.observed_usage,
                reconciled_cost_microunits: Some(0),
                cost_unknown: false,
                latency_ms: input.latency_ms,
                retry_after_ms: input.retry_after_ms,
                cancelled: input.cancelled,
                client_disconnected: input.client_disconnected,
                partial_stream: input.partial_stream,
                reconcile_status: ReconcileStatus::ReleasedWithoutCharge,
                reserved_tokens_released: reservation.reserved_tokens,
                tokens_charged: Some(0),
                recorded_at_ms: input.now_ms,
            };
            guard.outcome_receipts.push(receipt.clone());
            return Ok(ReconcileResult {
                status: ReconcileStatus::ReleasedWithoutCharge,
                reservation_status: ReservationStatus::ReconciledReleased,
                outcome_receipt: receipt,
            });
        }

        // Case C: Request was accepted by provider (`Accepted`), reconcile actual usage & cost.
        let (tokens_charged, usage_is_unknown) = match input.observed_usage {
            ObservedUsage::Known {
                input_tokens,
                output_tokens,
            } => (Some(input_tokens.saturating_add(output_tokens)), false),
            ObservedUsage::UsageUnknown => (None, true),
        };

        let resolved_cost: Option<u64> = match input.actual_cost {
            ObservedCost::Known { microunits } => Some(microunits),
            ObservedCost::CostUnknown => None,
            ObservedCost::ComputeFromPricing => match (input.observed_usage, candidate.as_ref()) {
                (
                    ObservedUsage::Known {
                        input_tokens,
                        output_tokens,
                    },
                    Some(c),
                ) => c.estimate_cost_microunits(input_tokens, output_tokens),
                _ => None,
            },
        };
        let cost_unknown = resolved_cost.is_none();

        if let Some(res) = guard.resources.get_mut(&reservation.candidate_id) {
            match tokens_charged {
                Some(charged) => {
                    if let QuotaState::Known {
                        ref mut remaining_tokens,
                        ..
                    } = res.quota
                    {
                        *remaining_tokens = remaining_tokens.saturating_sub(charged);
                    }
                }
                None => {
                    // Never silently treat missing usage headers as zero tokens!
                    res.unknown_usage_count = res.unknown_usage_count.saturating_add(1);
                    if let QuotaState::Known {
                        remaining_tokens,
                        emergency_reserve_tokens,
                        ..
                    } = res.quota
                    {
                        res.quota = QuotaState::Stale {
                            last_known_remaining_tokens: remaining_tokens,
                            observed_at_ms: res.freshness_ms,
                            stale_since_ms: input.now_ms,
                            emergency_reserve_tokens,
                        };
                        res.stale_marker = true;
                    }
                }
            }
            if let Some(cost) = resolved_cost {
                res.reconciled_cost_microunits =
                    res.reconciled_cost_microunits.saturating_add(cost);
            }
        }

        {
            let telem = telemetry_entry(
                &mut guard.telemetry,
                &reservation.provider_id,
                &reservation.model_id,
                &policy_class,
            );
            match tokens_charged {
                Some(tok) => {
                    telem.actual_tokens_total = telem.actual_tokens_total.saturating_add(tok)
                }
                None => {
                    telem.unknown_usage_outcomes = telem.unknown_usage_outcomes.saturating_add(1)
                }
            }
            match resolved_cost {
                Some(c) => {
                    telem.actual_cost_microunits_total =
                        telem.actual_cost_microunits_total.saturating_add(c)
                }
                None => telem.unknown_cost_outcomes = telem.unknown_cost_outcomes.saturating_add(1),
            }
        }

        let (reconcile_status, res_status) = if usage_is_unknown {
            (
                ReconcileStatus::ChargedWithUnknownUsage,
                ReservationStatus::ReconciledUnknownUsage,
            )
        } else {
            (
                ReconcileStatus::Charged,
                ReservationStatus::ReconciledCharged,
            )
        };

        if let Some(r) = guard.reservations.get_mut(&input.reservation_id) {
            r.status = res_status;
            r.updated_at_ms = input.now_ms;
        }

        let receipt = RouteOutcomeReceipt {
            schema_version: ROUTER_RECEIPT_SCHEMA_VERSION,
            sequence_id: seq_id,
            source_revision: guard.source_revision.clone(),
            redaction_policy: ROUTER_REDACTION_POLICY.to_owned(),
            reservation_id: input.reservation_id,
            decision_sequence_id: reservation.decision_sequence_id,
            attempt_id: input.attempt_id,
            candidate_id: reservation.candidate_id,
            generation_epoch: input.generation_epoch,
            response_class: input.response_class,
            accepted_by_provider: AcceptanceState::Accepted,
            observed_usage: input.observed_usage,
            reconciled_cost_microunits: resolved_cost,
            cost_unknown,
            latency_ms: input.latency_ms,
            retry_after_ms: input.retry_after_ms,
            cancelled: input.cancelled,
            client_disconnected: input.client_disconnected,
            partial_stream: input.partial_stream,
            reconcile_status,
            reserved_tokens_released: reservation.reserved_tokens,
            tokens_charged,
            recorded_at_ms: input.now_ms,
        };
        guard.outcome_receipts.push(receipt.clone());

        Ok(ReconcileResult {
            status: reconcile_status,
            reservation_status: res_status,
            outcome_receipt: receipt,
        })
    }

    /// Execute a fenced fallback route selection under the original privacy, region,
    /// authorization, and capability boundaries without permitting boundary relaxation.
    pub fn fallback_and_reserve(
        &self,
        prior_reservation_id: &str,
        admission: RetryAdmission,
        now_ms: i64,
    ) -> NativeResult<ReservationGrant> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let prior = guard
            .reservations
            .get(prior_reservation_id)
            .cloned()
            .ok_or_else(|| {
                NativeError::new(
                    "reservation_missing",
                    "Prior reservation for fallback not found",
                )
            })?;

        if prior.policy.fallback_scope == FallbackScope::None {
            return Err(NativeError::new(
                "fallback_disabled_by_policy",
                "Request policy forbids route fallback",
            ));
        }

        let new_idempotency_key = match (&admission, prior.status) {
            (
                RetryAdmission::ReuseAfterPreProviderRelease {
                    new_idempotency_key,
                },
                ReservationStatus::ReconciledReleased,
            ) => new_idempotency_key.clone(),
            (RetryAdmission::ReuseAfterPreProviderRelease { .. }, _) => {
                return Err(NativeError::new(
                    "retry_fenced_unproven_release",
                    "Cannot reuse reservation budget unless prior attempt proved pre-provider non-acceptance",
                ))
            }
            (_, ReservationStatus::InFlight) => {
                return Err(NativeError::new(
                    "retry_fenced_in_flight",
                    "Cannot dispatch fallback while prior attempt is still in flight",
                ))
            }
            (
                RetryAdmission::ExplicitNewReservation {
                    new_idempotency_key,
                },
                _,
            ) => new_idempotency_key.clone(),
        };

        let mut next_policy = prior.policy.clone();
        next_policy.idempotency_key = new_idempotency_key;
        if prior.policy.fallback_scope == FallbackScope::SameProviderOnly {
            next_policy.allowed_providers = vec![prior.provider_id.clone()];
        }

        Self::select_and_reserve_locked(
            &mut guard,
            next_policy,
            now_ms,
            true,
            Some(prior.reservation_id.clone()),
            prior.prior_candidates,
        )
    }

    /// Resolve an `OperatorRecoveryRequired` or `OrphanedOnRestart` reservation explicitly.
    pub fn resolve_operator_recovery(
        &self,
        reservation_id: &str,
        resolution: OperatorResolution,
        now_ms: i64,
    ) -> NativeResult<ReservationStatus> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let reservation = guard
            .reservations
            .get(reservation_id)
            .cloned()
            .ok_or_else(|| NativeError::new("reservation_missing", "Reservation not found"))?;

        if !matches!(
            reservation.status,
            ReservationStatus::OperatorRecoveryRequired | ReservationStatus::OrphanedOnRestart
        ) {
            return Err(NativeError::new(
                "recovery_not_pending",
                "Reservation is not awaiting operator recovery",
            ));
        }

        release_in_flight_hold(&mut guard, &reservation);

        let new_status = match resolution {
            OperatorResolution::ConfirmNotExecutedRelease => ReservationStatus::ReconciledReleased,
            OperatorResolution::ConfirmExecutedCharge {
                actual_tokens,
                actual_cost_microunits,
            } => {
                if let Some(res) = guard.resources.get_mut(&reservation.candidate_id) {
                    if let Some(tok) = actual_tokens {
                        if let QuotaState::Known {
                            ref mut remaining_tokens,
                            ..
                        } = res.quota
                        {
                            *remaining_tokens = remaining_tokens.saturating_sub(tok);
                        }
                    } else {
                        res.unknown_usage_count = res.unknown_usage_count.saturating_add(1);
                    }
                    if let Some(cost) = actual_cost_microunits {
                        res.reconciled_cost_microunits =
                            res.reconciled_cost_microunits.saturating_add(cost);
                    }
                }
                if actual_tokens.is_some() {
                    ReservationStatus::ReconciledCharged
                } else {
                    ReservationStatus::ReconciledUnknownUsage
                }
            }
        };

        if let Some(r) = guard.reservations.get_mut(reservation_id) {
            r.status = new_status;
            r.updated_at_ms = now_ms;
        }
        Ok(new_status)
    }

    pub fn export_recovery_snapshot(&self) -> RouterRecoverySnapshot {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        RouterRecoverySnapshot {
            schema_version: ROUTER_RECEIPT_SCHEMA_VERSION,
            source_revision: guard.source_revision.clone(),
            next_sequence_id: guard.next_sequence_id,
            next_epoch: guard.next_epoch,
            candidates: guard.candidates.clone(),
            resources: guard.resources.clone(),
            reservations: guard.reservations.clone(),
            idempotency_index: guard.idempotency_index.clone(),
            decision_receipts: guard.decision_receipts.clone(),
            outcome_receipts: guard.outcome_receipts.clone(),
            telemetry: guard.telemetry.clone(),
            fenced_late_outcomes: guard.fenced_late_outcomes,
        }
    }

    /// Restore ledger state after a host restart:
    /// - `InFlight` dispatches without terminal outcomes become `OperatorRecoveryRequired`
    ///   (fenced from automatic replay, keeping their quota hold visible).
    /// - `ReservedNotDispatched` reservations become `OrphanedOnRestart` so recovery
    ///   inspection or explicit release accounts for them cleanly.
    pub fn recover_after_restart(snapshot: RouterRecoverySnapshot, restart_at_ms: i64) -> Self {
        let mut reservations = snapshot.reservations;
        for res in reservations.values_mut() {
            match res.status {
                ReservationStatus::InFlight => {
                    res.status = ReservationStatus::OperatorRecoveryRequired;
                    res.updated_at_ms = restart_at_ms;
                }
                ReservationStatus::ReservedNotDispatched => {
                    res.status = ReservationStatus::OrphanedOnRestart;
                    res.updated_at_ms = restart_at_ms;
                }
                _ => {}
            }
        }
        Self {
            inner: Mutex::new(RouterLedger {
                source_revision: snapshot.source_revision,
                next_sequence_id: snapshot.next_sequence_id,
                next_epoch: snapshot.next_epoch.saturating_add(1),
                candidates: snapshot.candidates,
                resources: snapshot.resources,
                reservations,
                idempotency_index: snapshot.idempotency_index,
                decision_receipts: snapshot.decision_receipts,
                outcome_receipts: snapshot.outcome_receipts,
                telemetry: snapshot.telemetry,
                fenced_late_outcomes: snapshot.fenced_late_outcomes,
            }),
        }
    }

    pub fn decision_receipts(&self) -> Vec<RouteDecisionReceipt> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .decision_receipts
            .clone()
    }

    pub fn outcome_receipts(&self) -> Vec<RouteOutcomeReceipt> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .outcome_receipts
            .clone()
    }

    pub fn candidate_resource(&self, candidate_id: &str) -> Option<CandidateResourceState> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .resources
            .get(candidate_id)
            .cloned()
    }

    pub fn reservation_status(&self, reservation_id: &str) -> Option<ReservationStatus> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .reservations
            .get(reservation_id)
            .map(|r| r.status)
    }

    pub fn metrics_report(&self, now_ms: i64) -> RouterMetricsReport {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let by_route_and_policy = guard.telemetry.values().cloned().collect();
        let candidate_latencies = guard
            .resources
            .iter()
            .map(|(cid, res)| CandidateLatencyReport {
                candidate_id: cid.clone(),
                p50_ms: res.p50_latency_ms(),
                p95_ms: res.p95_latency_ms(),
                p99_ms: res.p99_latency_ms(),
                ewma_ms: res.ewma_latency_ms,
                circuit_state: res.circuit_state,
                circuit_transitions: res.circuit_transitions,
            })
            .collect();

        let mut orphaned_reservations = 0usize;
        let mut operator_recovery_required = 0usize;
        let mut in_flight_unreconciled = 0usize;
        let mut max_recovery_age_ms = 0u64;

        for res in guard.reservations.values() {
            match res.status {
                ReservationStatus::OrphanedOnRestart => {
                    orphaned_reservations += 1;
                    let age = now_ms.saturating_sub(res.created_at_ms).max(0) as u64;
                    max_recovery_age_ms = max_recovery_age_ms.max(age);
                }
                ReservationStatus::OperatorRecoveryRequired => {
                    operator_recovery_required += 1;
                    let age = now_ms.saturating_sub(res.created_at_ms).max(0) as u64;
                    max_recovery_age_ms = max_recovery_age_ms.max(age);
                }
                ReservationStatus::InFlight | ReservationStatus::ReservedNotDispatched => {
                    in_flight_unreconciled += 1;
                }
                _ => {}
            }
        }

        RouterMetricsReport {
            generated_at_ms: now_ms,
            by_route_and_policy,
            candidate_latencies,
            orphaned_reservations,
            operator_recovery_required,
            in_flight_unreconciled,
            max_recovery_age_ms,
            fenced_late_outcomes: guard.fenced_late_outcomes,
        }
    }
}

fn release_in_flight_hold(ledger: &mut RouterLedger, reservation: &ActiveReservation) {
    if let Some(res) = ledger.resources.get_mut(&reservation.candidate_id) {
        res.reserved_tokens = res
            .reserved_tokens
            .saturating_sub(reservation.reserved_tokens);
        res.reserved_cost_microunits = res
            .reserved_cost_microunits
            .saturating_sub(reservation.reserved_cost_microunits);
        res.concurrent_reservations = res.concurrent_reservations.saturating_sub(1);
        if reservation.used_half_open_probe
            && matches!(
                res.circuit_state,
                CircuitState::HalfOpen {
                    probe_in_flight: true
                }
            )
        {
            res.circuit_state = CircuitState::HalfOpen {
                probe_in_flight: false,
            };
        }
    }
}

fn telemetry_entry<'a>(
    map: &'a mut BTreeMap<String, RouteClassTelemetry>,
    provider_id: &str,
    model_id: &str,
    policy_class: &str,
) -> &'a mut RouteClassTelemetry {
    let key = format!("{provider_id}::{model_id}::{policy_class}");
    map.entry(key).or_insert_with(|| RouteClassTelemetry {
        provider_id: provider_id.to_owned(),
        model_id: model_id.to_owned(),
        policy_class: policy_class.to_owned(),
        ..RouteClassTelemetry::default()
    })
}

fn evaluate_candidate_eligibility(
    policy: &RouteRequestPolicy,
    candidate: &RouteCandidate,
    resource: &CandidateResourceState,
    needed_tokens: u64,
    now_ms: i64,
    excluded_prior: bool,
) -> Vec<RejectionReason> {
    let mut reasons = Vec::new();
    if excluded_prior {
        reasons.push(RejectionReason::ExcludedPriorAttempt);
    }
    if !candidate.enabled {
        reasons.push(RejectionReason::Disabled);
    }
    if candidate.auth_boundary != policy.required_auth_boundary {
        reasons.push(RejectionReason::UnauthorizedBoundary);
    }
    if candidate.auth_scheme != AuthScheme::None && !candidate.credential_present {
        reasons.push(RejectionReason::MissingCredential);
    }
    if candidate.local_network_endpoint
        && (!policy.allow_local_network || !candidate.local_network_grant)
    {
        reasons.push(RejectionReason::LocalNetworkGrantMissing);
    }
    if policy
        .forbidden_providers
        .iter()
        .any(|p| p == &candidate.provider_id)
        || policy
            .forbidden_models
            .iter()
            .any(|m| m == &candidate.model_id)
    {
        reasons.push(RejectionReason::ForbiddenProviderOrModel);
    }
    if !policy.allowed_providers.is_empty()
        && !policy
            .allowed_providers
            .iter()
            .any(|p| p == &candidate.provider_id)
    {
        reasons.push(RejectionReason::NotInAllowedSet);
    }
    if !policy.allowed_models.is_empty()
        && !policy
            .allowed_models
            .iter()
            .any(|m| m == &candidate.model_id)
    {
        reasons.push(RejectionReason::NotInAllowedSet);
    }
    if candidate.privacy_tier < policy.privacy_tier {
        reasons.push(RejectionReason::PrivacyBoundaryViolation);
    }
    if !policy.allowed_regions.is_empty()
        && !policy
            .allowed_regions
            .iter()
            .any(|r| r.eq_ignore_ascii_case(&candidate.region))
    {
        reasons.push(RejectionReason::RegionViolation);
    }
    if let Some(max_retention) = policy.max_retention_hours {
        if candidate.retention_hours > max_retention {
            reasons.push(RejectionReason::RetentionExceeded);
        }
    }

    let req = &policy.required_capabilities;
    let cap = &candidate.capabilities;
    if req.text && !cap.text {
        reasons.push(RejectionReason::MissingCapability("text".into()));
    }
    if req.vision && !cap.vision {
        reasons.push(RejectionReason::MissingCapability("vision".into()));
    }
    if req.audio && !cap.audio {
        reasons.push(RejectionReason::MissingCapability("audio".into()));
    }
    if req.tool_use && !cap.tool_use {
        reasons.push(RejectionReason::MissingCapability("tool_use".into()));
    }
    if req.structured_output && !cap.structured_output {
        reasons.push(RejectionReason::MissingCapability(
            "structured_output".into(),
        ));
    }
    if req.streaming && !cap.streaming {
        reasons.push(RejectionReason::MissingCapability("streaming".into()));
    }
    if req.max_attachments > cap.max_attachments {
        reasons.push(RejectionReason::MissingCapability(
            "attachments_limit".into(),
        ));
    }

    let required_context = policy.min_context_tokens.max(needed_tokens);
    if candidate.context_limit_tokens < required_context {
        reasons.push(RejectionReason::ContextLimitExceeded);
    }
    if candidate.max_output_tokens < policy.min_output_tokens.max(policy.estimated_output_tokens) {
        reasons.push(RejectionReason::OutputLimitExceeded);
    }
    if candidate.quality_tier < policy.min_quality_tier {
        reasons.push(RejectionReason::QualityBelowTarget);
    }

    match resource.circuit_state {
        CircuitState::Closed => {}
        CircuitState::Open { .. } => reasons.push(RejectionReason::CircuitOpen),
        CircuitState::HalfOpen {
            probe_in_flight: true,
        } => reasons.push(RejectionReason::HalfOpenProbeBusy),
        CircuitState::HalfOpen {
            probe_in_flight: false,
        } => {}
    }

    if let Some(until) = resource.retry_after_until_ms {
        if now_ms < until {
            reasons.push(RejectionReason::RetryAfterActive {
                retry_after_until_ms: until,
            });
        }
    }

    if resource.concurrent_reservations >= resource.max_concurrency {
        reasons.push(RejectionReason::ConcurrencyExhausted);
    }

    if let Some(budget_tokens) = policy.token_budget {
        if needed_tokens > budget_tokens {
            reasons.push(RejectionReason::TokenBudgetExceeded);
        }
    }

    // Explicit quota handling: never coerce Unknown/Stale/Contradictory to 0!
    match &resource.quota {
        QuotaState::Unknown { .. } => {
            reasons.push(RejectionReason::QuotaUnknown);
        }
        QuotaState::Contradictory { .. } => {
            reasons.push(RejectionReason::QuotaContradictory);
        }
        QuotaState::Stale {
            last_known_remaining_tokens,
            emergency_reserve_tokens,
            ..
        } => match policy.emergency_policy {
            EmergencyQuotaPolicy::AllowStaleQuotaWithCap { max_tokens }
                if needed_tokens <= max_tokens =>
            {
                let effective = last_known_remaining_tokens
                    .saturating_sub(resource.reserved_tokens)
                    .saturating_sub(*emergency_reserve_tokens);
                if needed_tokens > effective {
                    reasons.push(RejectionReason::QuotaExhausted);
                }
            }
            _ => reasons.push(RejectionReason::QuotaStale),
        },
        QuotaState::Known {
            remaining_tokens,
            emergency_reserve_tokens,
            ..
        } => {
            if resource.stale_marker {
                if !matches!(
                    policy.emergency_policy,
                    EmergencyQuotaPolicy::AllowStaleQuotaWithCap { max_tokens } if needed_tokens <= max_tokens
                ) {
                    reasons.push(RejectionReason::QuotaStale);
                }
            }
            let total_free = remaining_tokens.saturating_sub(resource.reserved_tokens);
            if needed_tokens > total_free {
                reasons.push(RejectionReason::QuotaExhausted);
            } else {
                let non_emergency_free = total_free.saturating_sub(*emergency_reserve_tokens);
                if needed_tokens > non_emergency_free
                    && !matches!(
                        policy.emergency_policy,
                        EmergencyQuotaPolicy::AllowEmergencyReserve
                    )
                {
                    reasons.push(RejectionReason::EmergencyReserveProtected);
                }
            }
        }
    }

    if let Some(max_cost) = policy.max_estimated_cost_microunits {
        match candidate.estimate_cost_microunits(
            policy.estimated_input_tokens,
            policy.estimated_output_tokens,
        ) {
            Some(est) if est > max_cost => reasons.push(RejectionReason::EstimatedCostExceeded),
            None => reasons.push(RejectionReason::PricingUnknownForBudget),
            Some(_) => {}
        }
    }

    if let Some(max_p95) = policy.max_latency_p95_ms {
        if let Some(observed_p95) = resource.p95_latency_ms() {
            if observed_p95 > max_p95 {
                reasons.push(RejectionReason::LatencyBudgetExceeded);
            }
        }
    }

    reasons
}

fn score_candidate(
    policy: &RouteRequestPolicy,
    candidate: &RouteCandidate,
    resource: &CandidateResourceState,
    needed_tokens: u64,
) -> CandidateScoreBreakdown {
    let quality_delta =
        i64::from(candidate.quality_tier).saturating_sub(i64::from(policy.min_quality_tier));
    let capability_fit_bps = 1_500i64 + (quality_delta.min(5) * 300);

    let privacy_rank = match candidate.privacy_tier {
        PrivacyTier::Public => 0i64,
        PrivacyTier::ZeroDataRetention => 500,
        PrivacyTier::PrivateVpc => 1_000,
        PrivacyTier::LocalOnly => 1_500,
    };
    let privacy_fit_bps = 1_000 + privacy_rank;

    let budget_headroom_bps = match &resource.quota {
        QuotaState::Known {
            remaining_tokens, ..
        } => {
            let avail = remaining_tokens.saturating_sub(resource.reserved_tokens);
            if avail == 0 {
                0
            } else {
                let ratio = ((avail.saturating_sub(needed_tokens)) as u128 * 2_000)
                    / (avail.max(1) as u128);
                (ratio as i64).clamp(0, 2_000)
            }
        }
        _ => 250,
    };

    let latency_health_bps = match resource
        .p95_latency_ms()
        .or_else(|| resource.ewma_latency_ms.map(|v| v.round() as u64))
    {
        None => 1_200,
        Some(ms) if ms <= 250 => 2_000,
        Some(ms) if ms <= 1_000 => 1_600,
        Some(ms) if ms <= 3_000 => 1_000,
        Some(_) => 300,
    };

    let total_outcomes = resource.success_count.saturating_add(resource.error_count);
    let mut reliability_bps = if total_outcomes == 0 {
        1_500i64
    } else {
        ((resource.success_count as u128 * 2_000) / (total_outcomes as u128)) as i64
    };
    if matches!(resource.circuit_state, CircuitState::HalfOpen { .. }) {
        reliability_bps = reliability_bps.saturating_sub(500);
    }

    let user_preference_bps = policy
        .preferred_candidate_ids
        .iter()
        .position(|id| id == &candidate.candidate_id)
        .map(|idx| (1_500i64).saturating_sub((idx as i64) * 300).max(300))
        .unwrap_or(0);

    let route_priority_bps = i64::from(candidate.route_priority).clamp(-1_000, 1_500);

    let total_score_bps = capability_fit_bps
        + privacy_fit_bps
        + budget_headroom_bps
        + latency_health_bps
        + reliability_bps
        + user_preference_bps
        + route_priority_bps;

    CandidateScoreBreakdown {
        candidate_id: candidate.candidate_id.clone(),
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

fn classify_no_route_error(rejected: &[RejectedCandidateRecord]) -> NativeError {
    let all_reasons: Vec<&RejectionReason> = rejected.iter().flat_map(|r| &r.reasons).collect();
    if all_reasons.is_empty() {
        return NativeError::new(
            "no_route_candidates",
            "No provider/model candidates are registered in the routing snapshot",
        );
    }
    if all_reasons.iter().any(|r| {
        matches!(
            r,
            RejectionReason::QuotaStale | RejectionReason::QuotaUnknown
        )
    }) && all_reasons.iter().all(|r| {
        matches!(
            r,
            RejectionReason::QuotaStale
                | RejectionReason::QuotaUnknown
                | RejectionReason::QuotaExhausted
                | RejectionReason::EmergencyReserveProtected
        )
    }) {
        return NativeError::retryable(
            "route_quota_unavailable_or_stale",
            "No eligible route has fresh sufficient quota under the active policy",
        )
        .with_provider_error_class(ProviderErrorClass::Quota);
    }
    if all_reasons.iter().all(|r| {
        matches!(
            r,
            RejectionReason::QuotaExhausted | RejectionReason::EmergencyReserveProtected
        )
    }) {
        return NativeError::new(
            "route_quota_exhausted",
            "All matching routes have exhausted non-emergency quota",
        )
        .with_provider_error_class(ProviderErrorClass::Quota);
    }
    if all_reasons.iter().any(|r| {
        matches!(
            r,
            RejectionReason::CircuitOpen | RejectionReason::RetryAfterActive { .. }
        )
    }) && all_reasons.iter().all(|r| {
        matches!(
            r,
            RejectionReason::CircuitOpen
                | RejectionReason::RetryAfterActive { .. }
                | RejectionReason::HalfOpenProbeBusy
        )
    }) {
        return NativeError::retryable(
            "route_circuit_or_backoff_active",
            "All matching routes are temporarily unavailable due to circuit breaker or retry-after backoff",
        )
        .with_provider_error_class(ProviderErrorClass::RateLimit);
    }
    NativeError::new(
        "no_eligible_route",
        "No route satisfied capability, privacy, authorization, and budget policies",
    )
}

/// Read-only projection over the canonical `provider_profiles` + `provider_models`
/// SQLite tables defined in `docs/storage-schema.sql`. Never creates or mutates tables.
pub struct ProviderModelRepository<'a> {
    connection: &'a Connection,
    app_profile_id: &'a str,
}

impl<'a> ProviderModelRepository<'a> {
    pub fn new(connection: &'a Connection, app_profile_id: &'a str) -> Self {
        Self {
            connection,
            app_profile_id,
        }
    }

    pub fn list_candidates(&self, now_ms: i64) -> NativeResult<Vec<RouteCandidate>> {
        let mut stmt = self.connection.prepare(
            "SELECT p.id, p.provider_type, p.display_name, p.normalized_base_url,
                    p.auth_scheme, p.organization_id, p.remote_project_id, p.credential_ref,
                    p.egress_policy_json, p.enabled, p.created_at_ms, p.updated_at_ms,
                    m.model_id, m.capabilities_json, m.limits_json, m.pricing_json,
                    m.discovered_at_ms, m.expires_at_ms
             FROM provider_profiles p
             INNER JOIN provider_models m ON m.provider_profile_id = p.id
             WHERE p.profile_id = ?1 AND p.deleted_at_ms IS NULL
             ORDER BY p.id ASC, m.model_id ASC",
        )?;

        let rows = stmt.query_map(params![self.app_profile_id], |row| {
            let profile = provider_profile_from_row(row)?;
            let egress_json: String = row.get(8)?;
            let model_id: String = row.get(12)?;
            let capabilities_json: String = row.get(13)?;
            let limits_json: String = row.get(14)?;
            let pricing_json: Option<String> = row.get(15)?;
            let discovered_at_ms: i64 = row.get(16)?;
            let expires_at_ms: Option<i64> = row.get(17)?;
            Ok((
                profile,
                egress_json,
                model_id,
                capabilities_json,
                limits_json,
                pricing_json,
                discovered_at_ms,
                expires_at_ms,
            ))
        })?;

        let mut out = Vec::new();
        for item in rows {
            let (
                profile,
                egress_json,
                model_id,
                capabilities_json,
                limits_json,
                pricing_json,
                discovered_at_ms,
                expires_at_ms,
            ) = item?;

            let selection_probe = provider_selection(ProviderProfileInput {
                provider_type: &profile.provider_type,
                base_url: &profile.normalized_base_url,
                auth_scheme: &profile.auth_scheme,
                organization: profile.organization_id.as_deref(),
                project: profile.remote_project_id.as_deref(),
                enabled: true,
                local_network_grant: profile.local_network_grant,
            });
            let Ok(sel) = selection_probe else {
                continue;
            };

            let caps_val =
                serde_json::from_str::<serde_json::Value>(&capabilities_json).unwrap_or_default();
            let limits_val =
                serde_json::from_str::<serde_json::Value>(&limits_json).unwrap_or_default();
            let pricing_val = pricing_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                .unwrap_or_default();
            let egress_val =
                serde_json::from_str::<serde_json::Value>(&egress_json).unwrap_or_default();

            let expired = expires_at_ms.is_some_and(|exp| now_ms >= exp);
            let capabilities = ModelCapabilities {
                text: caps_val
                    .get("text")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true),
                vision: caps_val
                    .get("vision")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                audio: caps_val
                    .get("audio")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                tool_use: caps_val
                    .get("toolUse")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                structured_output: caps_val
                    .get("structuredOutput")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                streaming: caps_val
                    .get("streaming")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true),
                max_attachments: caps_val
                    .get("maxAttachments")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0) as usize,
            };

            let privacy_tier = match egress_val
                .get("privacyTier")
                .and_then(serde_json::Value::as_str)
            {
                Some("local_only") => PrivacyTier::LocalOnly,
                Some("private_vpc") => PrivacyTier::PrivateVpc,
                Some("zero_data_retention") => PrivacyTier::ZeroDataRetention,
                _ if profile.provider_type.eq_ignore_ascii_case("local") => PrivacyTier::LocalOnly,
                _ => PrivacyTier::Public,
            };

            let local_endpoint = profile.normalized_base_url.contains("localhost")
                || profile.normalized_base_url.contains("127.0.0.1")
                || profile.provider_type.eq_ignore_ascii_case("local");

            out.push(RouteCandidate {
                candidate_id: format!("{}:{model_id}", profile.id),
                provider_id: profile.id.clone(),
                provider_type: profile.provider_type.clone(),
                model_id,
                adapter_family: sel.family,
                auth_scheme: sel.auth,
                auth_boundary: self.app_profile_id.to_owned(),
                capabilities,
                context_limit_tokens: limits_val
                    .get("contextTokens")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(128_000),
                max_output_tokens: limits_val
                    .get("maxOutputTokens")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(8_192),
                quality_tier: caps_val
                    .get("qualityTier")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(3) as u8,
                pricing_version: pricing_val
                    .get("version")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("discovered:{discovered_at_ms}")),
                input_cost_per_million_microunits: pricing_val
                    .get("inputPerMillionMicro")
                    .and_then(serde_json::Value::as_u64),
                output_cost_per_million_microunits: pricing_val
                    .get("outputPerMillionMicro")
                    .and_then(serde_json::Value::as_u64),
                region: egress_val
                    .get("region")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("global")
                    .to_ascii_lowercase(),
                privacy_tier,
                retention_hours: egress_val
                    .get("retentionHours")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(720) as u32,
                credential_present: profile.credential_status
                    == crate::profiles::CredentialStatus::Present,
                local_network_endpoint: local_endpoint,
                local_network_grant: profile.local_network_grant,
                enabled: profile.enabled && !expired,
                route_priority: caps_val
                    .get("routePriority")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(0) as i32,
                compatibility_notes: Vec::new(),
                last_qualification_receipt_id: None,
            });
        }
        Ok(out)
    }
}

/// Pure FIPS 180-4 SHA-256 digest formatted as 64 lowercase ASCII hex characters.
pub fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut padded = Vec::with_capacity(data.len() + 72);
    padded.extend_from_slice(data);
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = String::with_capacity(64);
    for word in h {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{word:08x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn base_policy(idem: &str) -> RouteRequestPolicy {
        RouteRequestPolicy {
            idempotency_key: idem.to_owned(),
            required_auth_boundary: "workspace-alpha".to_owned(),
            required_capabilities: ModelCapabilities {
                text: true,
                vision: false,
                audio: false,
                tool_use: true,
                structured_output: false,
                streaming: true,
                max_attachments: 0,
            },
            min_context_tokens: 32_000,
            min_output_tokens: 4_096,
            min_quality_tier: 3,
            task_risk: TaskRisk::Standard,
            privacy_tier: PrivacyTier::ZeroDataRetention,
            allowed_regions: vec!["us".into(), "eu".into()],
            max_retention_hours: Some(24),
            allow_local_network: false,
            estimated_input_tokens: 2_000,
            estimated_output_tokens: 1_000,
            max_estimated_cost_microunits: Some(100_000),
            max_actual_cost_microunits: Some(150_000),
            token_budget: Some(50_000),
            emergency_policy: EmergencyQuotaPolicy::Deny,
            deadline_ms: Some(50_000),
            max_latency_p95_ms: Some(2_500),
            allowed_providers: Vec::new(),
            forbidden_providers: Vec::new(),
            allowed_models: Vec::new(),
            forbidden_models: Vec::new(),
            preferred_candidate_ids: Vec::new(),
            fallback_scope: FallbackScope::SamePrivacyBoundary,
            cancelled: false,
        }
    }

    fn candidate(
        provider: &str,
        model: &str,
        privacy: PrivacyTier,
        region: &str,
    ) -> RouteCandidate {
        RouteCandidate {
            candidate_id: format!("{provider}:{model}"),
            provider_id: provider.to_owned(),
            provider_type: "openai".to_owned(),
            model_id: model.to_owned(),
            adapter_family: AdapterFamily::OpenAiResponses,
            auth_scheme: AuthScheme::Bearer,
            auth_boundary: "workspace-alpha".to_owned(),
            capabilities: ModelCapabilities {
                text: true,
                vision: true,
                audio: false,
                tool_use: true,
                structured_output: true,
                streaming: true,
                max_attachments: 8,
            },
            context_limit_tokens: 128_000,
            max_output_tokens: 16_384,
            quality_tier: 4,
            pricing_version: "2026-11-v1".to_owned(),
            input_cost_per_million_microunits: Some(3_000_000),
            output_cost_per_million_microunits: Some(15_000_000),
            region: region.to_owned(),
            privacy_tier: privacy,
            retention_hours: 0,
            credential_present: true,
            local_network_endpoint: false,
            local_network_grant: false,
            enabled: true,
            route_priority: 10,
            compatibility_notes: Vec::new(),
            last_qualification_receipt_id: Some("qual-1".into()),
        }
    }

    fn healthy_resource(remaining: u64, reserve: u64, now_ms: i64) -> CandidateResourceState {
        CandidateResourceState {
            quota: QuotaState::Known {
                remaining_tokens: remaining,
                window_reset_at_ms: now_ms + 60_000,
                window_capacity_tokens: Some(100_000),
                window_duration_ms: Some(60_000),
                emergency_reserve_tokens: reserve,
            },
            freshness_ms: now_ms,
            max_staleness_ms: Some(30_000),
            latency_samples_ms: vec![180, 210, 240, 290, 310],
            ewma_latency_ms: Some(245.0),
            success_count: 25,
            error_count: 1,
            ..CandidateResourceState::default()
        }
    }

    #[test]
    fn sha256_matches_nist_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    // Scenario 1: No eligible route after privacy/capability filtering + secret-free receipt.
    #[test]
    fn scenario_01_no_eligible_route_after_privacy_and_capability_filtering() {
        let router = DynamicRouterEngine::new("rev-test");
        let mut pub_cand = candidate("prov-a", "model-pub", PrivacyTier::Public, "us");
        pub_cand.capabilities.vision = false;
        router
            .upsert_candidate(pub_cand, healthy_resource(50_000, 5_000, 1_000))
            .unwrap();

        let mut policy = base_policy("idem-s1");
        policy.required_capabilities.vision = true;
        let err = router.select_and_reserve(policy, 1_000).unwrap_err();
        assert_eq!(err.code, "no_eligible_route");

        let receipts = router.decision_receipts();
        assert_eq!(receipts.len(), 1);
        assert!(receipts[0].selected_candidate_id.is_none());
        assert_eq!(receipts[0].rejected_candidates.len(), 1);
        assert!(receipts[0].rejected_candidates[0]
            .reasons
            .contains(&RejectionReason::PrivacyBoundaryViolation));
        assert!(receipts[0].rejected_candidates[0]
            .reasons
            .contains(&RejectionReason::MissingCapability("vision".into())));

        let serialized = serde_json::to_string(&receipts[0]).unwrap();
        assert!(!serialized.contains("idem-s1")); // hashed only
        let report = router.metrics_report(1_000);
        assert_eq!(report.by_route_and_policy[0].privacy_boundary_rejections, 1);
        assert_eq!(report.by_route_and_policy[0].reservation_failures, 1);
    }

    // Scenario 2: Quota exhausted, quota stale, quota unknown, window rollover, emergency reserve.
    #[test]
    fn scenario_02_quota_exhausted_stale_unknown_rollover_and_emergency_reserve() {
        let router = DynamicRouterEngine::new("rev-test");
        let cand = candidate("prov-a", "model-q", PrivacyTier::ZeroDataRetention, "us");

        // 2a: Unknown quota is explicitly rejected, never coerced to 0 or full.
        router
            .upsert_candidate(cand.clone(), CandidateResourceState::default())
            .unwrap();
        let err_unknown = router
            .select_and_reserve(base_policy("idem-q-unknown"), 1_000)
            .unwrap_err();
        assert_eq!(err_unknown.code, "route_quota_unavailable_or_stale");

        // 2b: Remaining 7_000 with 5_000 emergency reserve -> 2_000 normal free < 3_000 needed!
        router
            .upsert_candidate(cand.clone(), healthy_resource(7_000, 5_000, 1_000))
            .unwrap();
        let err_reserve = router
            .select_and_reserve(base_policy("idem-q-reserve-deny"), 1_000)
            .unwrap_err();
        assert_eq!(err_reserve.code, "route_quota_exhausted");

        // Explicitly admitting emergency reserve allows dipping into the 5_000 reserve:
        let mut emergency_pol = base_policy("idem-q-reserve-allow");
        emergency_pol.emergency_policy = EmergencyQuotaPolicy::AllowEmergencyReserve;
        let grant = router.select_and_reserve(emergency_pol, 1_000).unwrap();
        assert_eq!(grant.reserved_tokens, 3_000);

        // Exhaust remaining 4_000 when asking for 5_000:
        let mut big_pol = base_policy("idem-q-exhausted");
        big_pol.estimated_input_tokens = 4_000;
        big_pol.estimated_output_tokens = 1_500;
        big_pol.emergency_policy = EmergencyQuotaPolicy::AllowEmergencyReserve;
        assert_eq!(
            router
                .select_and_reserve(big_pol.clone(), 1_000)
                .unwrap_err()
                .code,
            "route_quota_exhausted"
        );

        // 2c: Stale quota (past max_staleness_ms=30_000 before window_reset_at_ms=61_000)
        // is explicitly rejected until window rollover!
        assert_eq!(
            router
                .select_and_reserve(base_policy("idem-q-stale"), 45_000)
                .unwrap_err()
                .code,
            "route_quota_unavailable_or_stale"
        );

        // 2d: Window rollover at t = 62_000 replenishes known window capacity (100_000)!
        router
            .upsert_candidate(cand, healthy_resource(4_000, 1_000, 1_000))
            .unwrap();
        let rolled = router
            .select_and_reserve(big_pol, 62_000)
            .expect("window rollover replenishes capacity");
        assert_eq!(rolled.reserved_tokens, 5_500);
    }

    // Scenario 3: Simultaneous concurrent reservations + idempotent duplicate dispatch + tie-break.
    #[test]
    fn scenario_03_simultaneous_reservations_idempotency_and_deterministic_tiebreak() {
        let router = Arc::new(DynamicRouterEngine::new("rev-test"));
        // Two identical-score candidates -> tie MUST break deterministically by stable candidate_id.
        router
            .upsert_candidate(
                candidate("prov-b", "m1", PrivacyTier::ZeroDataRetention, "us"),
                healthy_resource(9_000, 0, 1_000),
            )
            .unwrap();
        router
            .upsert_candidate(
                candidate("prov-a", "m1", PrivacyTier::ZeroDataRetention, "us"),
                healthy_resource(9_000, 0, 1_000),
            )
            .unwrap();

        let first = router
            .select_and_reserve(base_policy("idem-tie"), 1_000)
            .unwrap();
        assert_eq!(first.candidate_id, "prov-a:m1");
        let replay = router
            .select_and_reserve(base_policy("idem-tie"), 1_050)
            .unwrap();
        assert!(replay.idempotent_replay);
        assert_eq!(replay.reservation_id, first.reservation_id);
        assert_eq!(
            router
                .candidate_resource("prov-a:m1")
                .unwrap()
                .reserved_tokens,
            3_000
        );

        // Conflicting policy with same idempotency_key is rejected:
        let mut altered = base_policy("idem-tie");
        altered.estimated_input_tokens = 9_999;
        assert_eq!(
            router.select_and_reserve(altered, 1_060).unwrap_err().code,
            "invalid_input"
        );

        // Remaining total pool across prov-a (6_000 left) + prov-b (9_000 left) = 15_000 tokens
        // = exactly 5 more 3_000-token reservations across 10 racing threads!
        let mut handles = Vec::new();
        for idx in 0..10 {
            let engine = Arc::clone(&router);
            handles.push(std::thread::spawn(move || {
                engine.select_and_reserve(base_policy(&format!("race-{idx}")), 1_100)
            }));
        }
        let outcomes: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let successes = outcomes.iter().filter(|r| r.is_ok()).count();
        let failures = outcomes.iter().filter(|r| r.is_err()).count();
        assert_eq!(successes, 5);
        assert_eq!(failures, 5);
    }

    // Scenario 4: Provider outage, timeout, retry-after storm, and circuit transitions.
    #[test]
    fn scenario_04_outage_timeout_retry_after_and_circuit_state_machine() {
        let router = DynamicRouterEngine::new("rev-test");
        let cand = candidate("prov-a", "m-circuit", PrivacyTier::ZeroDataRetention, "us");
        let mut init_res = healthy_resource(100_000, 0, 1_000);
        init_res.max_staleness_ms = Some(60_000);
        router.upsert_candidate(cand, init_res).unwrap();

        let circuit_policy = |idem: &str| {
            let mut pol = base_policy(idem);
            pol.max_latency_p95_ms = Some(10_000);
            pol
        };

        // 3 consecutive timeouts/429s trip Closed -> Open
        for i in 0..3 {
            let grant = router
                .select_and_reserve(circuit_policy(&format!("trip-{i}")), 1_000 + i * 10)
                .unwrap();
            let att = router
                .begin_attempt(&grant.reservation_id, 1_005 + i * 10)
                .unwrap();
            let class = if i == 2 {
                ProviderErrorClass::RateLimit
            } else {
                ProviderErrorClass::Timeout
            };
            router
                .reconcile_outcome(OutcomeInput {
                    reservation_id: grant.reservation_id,
                    attempt_id: att.attempt_id,
                    generation_epoch: grant.generation_epoch,
                    response_class: Some(class),
                    accepted_by_provider: AcceptanceState::NotSent,
                    observed_usage: ObservedUsage::UsageUnknown,
                    actual_cost: ObservedCost::CostUnknown,
                    latency_ms: Some(5_000),
                    retry_after_ms: if i == 2 { Some(40_000) } else { None },
                    cancelled: false,
                    client_disconnected: false,
                    partial_stream: false,
                    now_ms: 1_008 + i * 10,
                })
                .unwrap();
        }

        let res_open = router.candidate_resource("prov-a:m-circuit").unwrap();
        assert!(matches!(res_open.circuit_state, CircuitState::Open { .. }));

        // Blocked while Open / Retry-After active:
        assert_eq!(
            router
                .select_and_reserve(circuit_policy("while-open"), 10_000)
                .unwrap_err()
                .code,
            "route_circuit_or_backoff_active"
        );

        // After cooldown (1_028 + 40_000 = 41_028), strict 2500ms p95 budget still rejects 5000ms p95:
        assert!(router
            .select_and_reserve(base_policy("strict-p95-gate"), 42_000)
            .is_err());

        // With 10_000ms p95 budget, transitions Open -> HalfOpen and admits 1 probe!
        let probe_grant = router
            .select_and_reserve(circuit_policy("half-open-probe"), 42_000)
            .unwrap();
        // Second concurrent caller during HalfOpen probe is rejected (`HalfOpenProbeBusy`):
        assert!(router
            .select_and_reserve(circuit_policy("second-during-probe"), 42_001)
            .is_err());

        let probe_att = router
            .begin_attempt(&probe_grant.reservation_id, 42_005)
            .unwrap();
        router
            .reconcile_outcome(OutcomeInput {
                reservation_id: probe_grant.reservation_id,
                attempt_id: probe_att.attempt_id,
                generation_epoch: probe_grant.generation_epoch,
                response_class: None,
                accepted_by_provider: AcceptanceState::Accepted,
                observed_usage: ObservedUsage::Known {
                    input_tokens: 1_500,
                    output_tokens: 500,
                },
                actual_cost: ObservedCost::ComputeFromPricing,
                latency_ms: Some(220),
                retry_after_ms: None,
                cancelled: false,
                client_disconnected: false,
                partial_stream: false,
                now_ms: 42_250,
            })
            .unwrap();

        let res_closed = router.candidate_resource("prov-a:m-circuit").unwrap();
        assert_eq!(res_closed.circuit_state, CircuitState::Closed);
        assert!(res_closed.circuit_transitions >= 3);
    }

    // Scenario 5: Estimate/actual cost mismatch and missing usage headers (never zeroed!).
    #[test]
    fn scenario_05_cost_mismatch_and_missing_usage_headers_never_zeroed() {
        let router = DynamicRouterEngine::new("rev-test");
        router
            .upsert_candidate(
                candidate("prov-a", "m-usage", PrivacyTier::ZeroDataRetention, "us"),
                healthy_resource(50_000, 0, 1_000),
            )
            .unwrap();

        // 5a: Actual usage exceeds estimate -> deducts actual tokens & records actual cost.
        let g1 = router
            .select_and_reserve(base_policy("cost-mismatch"), 1_000)
            .unwrap();
        let a1 = router.begin_attempt(&g1.reservation_id, 1_010).unwrap();
        let rec1 = router
            .reconcile_outcome(OutcomeInput {
                reservation_id: g1.reservation_id,
                attempt_id: a1.attempt_id,
                generation_epoch: g1.generation_epoch,
                response_class: None,
                accepted_by_provider: AcceptanceState::Accepted,
                observed_usage: ObservedUsage::Known {
                    input_tokens: 4_000,
                    output_tokens: 2_000,
                },
                actual_cost: ObservedCost::ComputeFromPricing,
                latency_ms: Some(300),
                retry_after_ms: None,
                cancelled: false,
                client_disconnected: false,
                partial_stream: false,
                now_ms: 1_310,
            })
            .unwrap();
        assert_eq!(rec1.status, ReconcileStatus::Charged);
        assert_eq!(rec1.outcome_receipt.tokens_charged, Some(6_000));

        // 5b: Missing usage headers (`UsageUnknown`) -> transitions quota to Stale (NOT 0 tokens!)
        let g2 = router
            .select_and_reserve(base_policy("missing-headers"), 1_400)
            .unwrap();
        let a2 = router.begin_attempt(&g2.reservation_id, 1_410).unwrap();
        let rec2 = router
            .reconcile_outcome(OutcomeInput {
                reservation_id: g2.reservation_id,
                attempt_id: a2.attempt_id,
                generation_epoch: g2.generation_epoch,
                response_class: None,
                accepted_by_provider: AcceptanceState::Accepted,
                observed_usage: ObservedUsage::UsageUnknown,
                actual_cost: ObservedCost::CostUnknown,
                latency_ms: Some(280),
                retry_after_ms: None,
                cancelled: false,
                client_disconnected: false,
                partial_stream: false,
                now_ms: 1_700,
            })
            .unwrap();
        assert_eq!(rec2.status, ReconcileStatus::ChargedWithUnknownUsage);
        assert_eq!(rec2.outcome_receipt.tokens_charged, None);
        assert!(rec2.outcome_receipt.cost_unknown);
        let state_after = router.candidate_resource("prov-a:m-usage").unwrap();
        assert_eq!(state_after.unknown_usage_count, 1);
        assert!(matches!(state_after.quota, QuotaState::Stale { .. }));
    }

    // Scenario 6: Partial stream, cancellation, client disconnect, and late remote outcome fencing.
    #[test]
    fn scenario_06_partial_stream_cancellation_and_late_outcome_fencing() {
        let router = DynamicRouterEngine::new("rev-test");
        router
            .upsert_candidate(
                candidate("prov-a", "m-stream", PrivacyTier::ZeroDataRetention, "us"),
                healthy_resource(50_000, 0, 1_000),
            )
            .unwrap();

        let g = router
            .select_and_reserve(base_policy("stream-cancel"), 1_000)
            .unwrap();
        let a = router.begin_attempt(&g.reservation_id, 1_005).unwrap();
        let first_rec = router
            .reconcile_outcome(OutcomeInput {
                reservation_id: g.reservation_id.clone(),
                attempt_id: a.attempt_id.clone(),
                generation_epoch: g.generation_epoch,
                response_class: Some(ProviderErrorClass::Cancelled),
                accepted_by_provider: AcceptanceState::Accepted,
                observed_usage: ObservedUsage::Known {
                    input_tokens: 2_000,
                    output_tokens: 180,
                },
                actual_cost: ObservedCost::ComputeFromPricing,
                latency_ms: Some(410),
                retry_after_ms: None,
                cancelled: true,
                client_disconnected: true,
                partial_stream: true,
                now_ms: 1_415,
            })
            .unwrap();
        assert_eq!(first_rec.status, ReconcileStatus::Charged);
        let rem_after_first = match router.candidate_resource("prov-a:m-stream").unwrap().quota {
            QuotaState::Known {
                remaining_tokens, ..
            } => remaining_tokens,
            other => panic!("unexpected quota: {other:?}"),
        };
        assert_eq!(rem_after_first, 50_000 - 2_180);

        // Late remote response arrives after cancellation/reconciliation -> FENCED, zero extra charge!
        let late_rec = router
            .reconcile_outcome(OutcomeInput {
                reservation_id: g.reservation_id,
                attempt_id: a.attempt_id,
                generation_epoch: g.generation_epoch,
                response_class: None,
                accepted_by_provider: AcceptanceState::Accepted,
                observed_usage: ObservedUsage::Known {
                    input_tokens: 2_000,
                    output_tokens: 1_000,
                },
                actual_cost: ObservedCost::ComputeFromPricing,
                latency_ms: Some(2_000),
                retry_after_ms: None,
                cancelled: false,
                client_disconnected: false,
                partial_stream: false,
                now_ms: 3_000,
            })
            .unwrap();
        assert_eq!(
            late_rec.status,
            ReconcileStatus::FencedDuplicateOrSuperseded
        );
        let rem_after_late = match router.candidate_resource("prov-a:m-stream").unwrap().quota {
            QuotaState::Known {
                remaining_tokens, ..
            } => remaining_tokens,
            other => panic!("unexpected quota: {other:?}"),
        };
        assert_eq!(rem_after_late, 50_000 - 2_180);
        assert_eq!(router.metrics_report(3_000).fenced_late_outcomes, 1);
    }

    // Scenario 7: Fallback that would cross privacy, region, authorization, or capability boundary.
    #[test]
    fn scenario_07_fallback_never_crosses_privacy_region_auth_or_capability_boundary() {
        let router = DynamicRouterEngine::new("rev-test");
        // Primary compliant candidate
        router
            .upsert_candidate(
                candidate("prov-a", "primary", PrivacyTier::ZeroDataRetention, "us"),
                healthy_resource(50_000, 0, 1_000),
            )
            .unwrap();
        // Boundary-violating alternatives (public privacy, wrong region, wrong auth boundary)
        router
            .upsert_candidate(
                candidate("prov-b", "public-fallback", PrivacyTier::Public, "us"),
                healthy_resource(50_000, 0, 1_000),
            )
            .unwrap();
        router
            .upsert_candidate(
                candidate(
                    "prov-c",
                    "ap-fallback",
                    PrivacyTier::ZeroDataRetention,
                    "ap-east",
                ),
                healthy_resource(50_000, 0, 1_000),
            )
            .unwrap();
        let mut wrong_auth = candidate("prov-d", "foreign", PrivacyTier::LocalOnly, "us");
        wrong_auth.auth_boundary = "workspace-other".into();
        router
            .upsert_candidate(wrong_auth, healthy_resource(50_000, 0, 1_000))
            .unwrap();

        let g = router
            .select_and_reserve(base_policy("fb-1"), 1_000)
            .unwrap();
        let a = router.begin_attempt(&g.reservation_id, 1_005).unwrap();
        router
            .reconcile_outcome(OutcomeInput {
                reservation_id: g.reservation_id.clone(),
                attempt_id: a.attempt_id,
                generation_epoch: g.generation_epoch,
                response_class: Some(ProviderErrorClass::Transport),
                accepted_by_provider: AcceptanceState::NotSent,
                observed_usage: ObservedUsage::UsageUnknown,
                actual_cost: ObservedCost::CostUnknown,
                latency_ms: Some(80),
                retry_after_ms: None,
                cancelled: false,
                client_disconnected: false,
                partial_stream: false,
                now_ms: 1_090,
            })
            .unwrap();

        let fb_err = router
            .fallback_and_reserve(
                &g.reservation_id,
                RetryAdmission::ReuseAfterPreProviderRelease {
                    new_idempotency_key: "fb-2".into(),
                },
                1_100,
            )
            .unwrap_err();
        assert_eq!(fb_err.code, "no_eligible_route");

        // Adding a compliant ZDR EU fallback succeeds cleanly:
        router
            .upsert_candidate(
                candidate(
                    "prov-e",
                    "eu-compliant",
                    PrivacyTier::ZeroDataRetention,
                    "eu",
                ),
                healthy_resource(50_000, 0, 1_100),
            )
            .unwrap();
        let fb_ok = router
            .fallback_and_reserve(
                &g.reservation_id,
                RetryAdmission::ReuseAfterPreProviderRelease {
                    new_idempotency_key: "fb-3".into(),
                },
                1_120,
            )
            .unwrap();
        assert_eq!(fb_ok.candidate_id, "prov-e:eu-compliant");
        assert!(fb_ok.decision_receipt.is_fallback);
    }

    // Scenario 8: Model disabled or registry/pricing revision changed after reservation.
    #[test]
    fn scenario_08_model_disabled_or_pricing_changed_after_reservation_is_fenced() {
        let router = DynamicRouterEngine::new("rev-test");
        let cand = candidate("prov-a", "m-drift", PrivacyTier::ZeroDataRetention, "us");
        router
            .upsert_candidate(cand.clone(), healthy_resource(50_000, 0, 1_000))
            .unwrap();

        let g1 = router
            .select_and_reserve(base_policy("drift-pricing"), 1_000)
            .unwrap();
        let mut repriced = cand.clone();
        repriced.pricing_version = "2026-11-v2-hike".into();
        router.update_candidate_metadata(repriced.clone()).unwrap();

        let err = router.begin_attempt(&g1.reservation_id, 1_020).unwrap_err();
        assert_eq!(err.code, "candidate_invalidated_after_reservation");
        // Reservation hold was cleanly released:
        assert_eq!(
            router
                .candidate_resource("prov-a:m-drift")
                .unwrap()
                .reserved_tokens,
            0
        );

        let g2 = router
            .select_and_reserve(base_policy("drift-disable"), 1_030)
            .unwrap();
        repriced.enabled = false;
        router.update_candidate_metadata(repriced).unwrap();
        assert_eq!(
            router
                .begin_attempt(&g2.reservation_id, 1_040)
                .unwrap_err()
                .code,
            "candidate_invalidated_after_reservation"
        );
    }

    // Scenario 9 & 10: Restart between reservation/dispatch/reconciliation AND unknown remote outcome.
    #[test]
    fn scenario_09_and_10_restart_recovery_and_unknown_remote_outcome_fencing() {
        let router = DynamicRouterEngine::new("rev-test");
        router
            .upsert_candidate(
                candidate("prov-a", "m-rec", PrivacyTier::ZeroDataRetention, "us"),
                healthy_resource(50_000, 0, 1_000),
            )
            .unwrap();

        // Reservation A: reserved but not yet dispatched before crash/restart
        let g_not_dispatched = router
            .select_and_reserve(base_policy("restart-undispatched"), 1_000)
            .unwrap();
        // Reservation B: in-flight dispatch when process restarts
        let g_inflight = router
            .select_and_reserve(base_policy("restart-inflight"), 1_010)
            .unwrap();
        let _att_inflight = router
            .begin_attempt(&g_inflight.reservation_id, 1_015)
            .unwrap();

        let snapshot = router.export_recovery_snapshot();
        let recovered = DynamicRouterEngine::recover_after_restart(snapshot, 5_000);

        assert_eq!(
            recovered.reservation_status(&g_not_dispatched.reservation_id),
            Some(ReservationStatus::OrphanedOnRestart)
        );
        assert_eq!(
            recovered.reservation_status(&g_inflight.reservation_id),
            Some(ReservationStatus::OperatorRecoveryRequired)
        );

        let metrics = recovered.metrics_report(6_000);
        assert_eq!(metrics.orphaned_reservations, 1);
        assert_eq!(metrics.operator_recovery_required, 1);
        assert!(metrics.max_recovery_age_ms >= 4_990);

        // Blind retry reusing unproven reservation MUST be fenced:
        assert_eq!(
            recovered
                .fallback_and_reserve(
                    &g_inflight.reservation_id,
                    RetryAdmission::ReuseAfterPreProviderRelease {
                        new_idempotency_key: "illegal-reuse".into()
                    },
                    6_010
                )
                .unwrap_err()
                .code,
            "retry_fenced_unproven_release"
        );

        // Explicit operator recovery resolves both holds cleanly:
        assert_eq!(
            recovered
                .resolve_operator_recovery(
                    &g_not_dispatched.reservation_id,
                    OperatorResolution::ConfirmNotExecutedRelease,
                    6_100
                )
                .unwrap(),
            ReservationStatus::ReconciledReleased
        );
        assert_eq!(
            recovered
                .resolve_operator_recovery(
                    &g_inflight.reservation_id,
                    OperatorResolution::ConfirmExecutedCharge {
                        actual_tokens: Some(2_500),
                        actual_cost_microunits: Some(18_000),
                    },
                    6_200
                )
                .unwrap(),
            ReservationStatus::ReconciledCharged
        );

        let post_metrics = recovered.metrics_report(6_300);
        assert_eq!(post_metrics.orphaned_reservations, 0);
        assert_eq!(post_metrics.operator_recovery_required, 0);
        assert_eq!(
            recovered
                .candidate_resource("prov-a:m-rec")
                .unwrap()
                .reserved_tokens,
            0
        );
    }

    #[test]
    fn sqlite_provider_model_repository_reads_canonical_schema_without_leaking_secrets() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE provider_profiles (
                id TEXT PRIMARY KEY, profile_id TEXT NOT NULL,
                provider_type TEXT NOT NULL, display_name TEXT NOT NULL,
                normalized_base_url TEXT NOT NULL, auth_scheme TEXT NOT NULL,
                organization_id TEXT, remote_project_id TEXT, credential_ref TEXT,
                egress_policy_json TEXT NOT NULL, enabled INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
                deleted_at_ms INTEGER
             );
             CREATE TABLE provider_models (
                provider_profile_id TEXT NOT NULL,
                model_id TEXT NOT NULL,
                display_name TEXT,
                capabilities_json TEXT NOT NULL,
                limits_json TEXT NOT NULL,
                pricing_json TEXT,
                discovered_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER,
                PRIMARY KEY (provider_profile_id, model_id)
             );",
        )
        .unwrap();

        conn.execute(
            "INSERT INTO provider_profiles VALUES (
                'prov_1','app_main','anthropic','Claude Prod','https://api.anthropic.com',
                'api_key_header',NULL,NULL,'provider_secret_0123456789abcdef0123456789abcdef',
                '{\"privacyTier\":\"zero_data_retention\",\"region\":\"us\",\"retentionHours\":0}',
                1,100,200,NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO provider_models VALUES (
                'prov_1','claude-sonnet-4','Claude Sonnet 4',
                '{\"text\":true,\"vision\":true,\"toolUse\":true,\"qualityTier\":5}',
                '{\"contextTokens\":200000,\"maxOutputTokens\":16384}',
                '{\"version\":\"2026-11\",\"inputPerMillionMicro\":3000000,\"outputPerMillionMicro\":15000000}',
                1000,NULL)",
            [],
        )
        .unwrap();

        let repo = ProviderModelRepository::new(&conn, "app_main");
        let list = repo.list_candidates(2_000).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].candidate_id, "prov_1:claude-sonnet-4");
        assert!(list[0].credential_present);
        assert_eq!(list[0].privacy_tier, PrivacyTier::ZeroDataRetention);
        let json_text = serde_json::to_string(&list[0]).unwrap();
        assert!(!json_text.contains("provider_secret_"));
    }
}
