#pragma once

#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace omnia::routing {

enum class PrivacyTier : std::uint8_t {
    Public = 0,
    ZeroDataRetention = 1,
    PrivateVpc = 2,
    LocalOnly = 3
};

enum class TaskRisk : std::uint8_t {
    Low = 0,
    Standard = 1,
    High = 2,
    Critical = 3
};

enum class FallbackScope : std::uint8_t {
    None = 0,
    SameProviderOnly = 1,
    SamePrivacyBoundary = 2
};

enum class EmergencyQuotaMode : std::uint8_t {
    Deny = 0,
    AllowEmergencyReserve = 1,
    AllowStaleQuotaWithCap = 2
};

struct EmergencyQuotaPolicy {
    EmergencyQuotaMode mode = EmergencyQuotaMode::Deny;
    std::uint64_t max_stale_tokens = 0;

    static EmergencyQuotaPolicy deny() { return {}; }
    static EmergencyQuotaPolicy allow_emergency_reserve() {
        return {EmergencyQuotaMode::AllowEmergencyReserve, 0};
    }
    static EmergencyQuotaPolicy allow_stale_with_cap(std::uint64_t cap) {
        return {EmergencyQuotaMode::AllowStaleQuotaWithCap, cap};
    }
};

struct ModelCapabilities {
    bool text = true;
    bool vision = false;
    bool audio = false;
    bool tool_use = false;
    bool structured_output = false;
    bool streaming = true;
    std::size_t max_attachments = 0;
};

struct QuotaState {
    enum class Kind : std::uint8_t {
        Known,
        Unknown,
        Stale,
        Contradictory
    };

    Kind kind = Kind::Unknown;
    std::uint64_t remaining_tokens = 0;
    std::int64_t window_reset_at_ms = 0;
    std::optional<std::uint64_t> window_capacity_tokens;
    std::optional<std::int64_t> window_duration_ms;
    std::uint64_t emergency_reserve_tokens = 0;
    std::int64_t observed_at_ms = 0;
    std::int64_t stale_since_ms = 0;
    std::string detail = "uninitialized_quota_snapshot";

    static QuotaState make_known(
        std::uint64_t remaining,
        std::uint64_t emergency_reserve,
        std::int64_t window_reset_ms,
        std::optional<std::uint64_t> capacity = std::nullopt,
        std::optional<std::int64_t> duration_ms = std::nullopt
    ) {
        QuotaState q{};
        q.kind = Kind::Known;
        q.remaining_tokens = remaining;
        q.emergency_reserve_tokens = emergency_reserve;
        q.window_reset_at_ms = window_reset_ms;
        q.window_capacity_tokens = capacity;
        q.window_duration_ms = duration_ms;
        q.detail.clear();
        return q;
    }

    static QuotaState make_unknown(std::string reason) {
        QuotaState q{};
        q.kind = Kind::Unknown;
        q.detail = std::move(reason);
        return q;
    }

    static QuotaState make_stale(
        std::uint64_t last_known_remaining,
        std::int64_t observed_ms,
        std::int64_t stale_ms,
        std::uint64_t emergency_reserve = 0
    ) {
        QuotaState q{};
        q.kind = Kind::Stale;
        q.remaining_tokens = last_known_remaining;
        q.observed_at_ms = observed_ms;
        q.stale_since_ms = stale_ms;
        q.emergency_reserve_tokens = emergency_reserve;
        q.detail = "stale_quota_snapshot";
        return q;
    }

    static QuotaState make_contradictory(std::string explanation) {
        QuotaState q{};
        q.kind = Kind::Contradictory;
        q.detail = std::move(explanation);
        return q;
    }
};

struct CircuitState {
    enum class Kind : std::uint8_t {
        Closed,
        Open,
        HalfOpen
    };

    Kind kind = Kind::Closed;
    std::int64_t opened_at_ms = 0;
    std::uint64_t cooldown_ms = 30000;
    bool probe_in_flight = false;

    static CircuitState closed() { return {}; }
    static CircuitState open(std::int64_t opened_ms, std::uint64_t cooldown = 30000) {
        CircuitState c{};
        c.kind = Kind::Open;
        c.opened_at_ms = opened_ms;
        c.cooldown_ms = cooldown;
        return c;
    }
    static CircuitState half_open(bool busy = false) {
        CircuitState c{};
        c.kind = Kind::HalfOpen;
        c.probe_in_flight = busy;
        return c;
    }
};

struct RouteCandidate {
    std::string candidate_id;
    std::string provider_id;
    std::string model_id;
    std::string auth_boundary = "workspace:default";
    ModelCapabilities capabilities{};
    std::uint64_t context_limit_tokens = 128000;
    std::uint64_t max_output_tokens = 16384;
    std::uint8_t quality_tier = 3;
    std::string pricing_version = "v1";
    std::optional<std::uint64_t> input_cost_per_million_microunits = 3000000;
    std::optional<std::uint64_t> output_cost_per_million_microunits = 15000000;
    std::string region = "us";
    PrivacyTier privacy_tier = PrivacyTier::ZeroDataRetention;
    std::uint32_t retention_hours = 0;
    bool credential_present = true;
    bool enabled = true;
    std::int32_t route_priority = 0;

    std::optional<std::uint64_t> estimate_cost_microunits(
        std::uint64_t in_tokens,
        std::uint64_t out_tokens
    ) const noexcept;
};

struct CandidateResourceState {
    QuotaState quota = QuotaState::make_unknown("uninitialized");
    std::uint64_t reserved_tokens = 0;
    std::uint64_t reserved_cost_microunits = 0;
    std::uint64_t reconciled_cost_microunits = 0;
    std::uint64_t unknown_usage_count = 0;
    std::optional<double> ewma_latency_ms;
    std::vector<std::uint64_t> latency_samples_ms;
    std::uint64_t timeout_count = 0;
    std::uint64_t error_count = 0;
    std::uint64_t success_count = 0;
    std::optional<std::int64_t> retry_after_until_ms;
    CircuitState circuit_state = CircuitState::closed();
    std::uint32_t circuit_failure_threshold = 3;
    std::uint64_t circuit_cooldown_ms = 30000;
    std::uint32_t consecutive_failures = 0;
    std::uint64_t circuit_transitions = 0;
    std::int64_t freshness_ms = 0;
    std::optional<std::int64_t> max_staleness_ms;
    std::uint32_t concurrent_reservations = 0;
    std::uint32_t max_concurrency = 16;
    std::uint64_t epoch = 1;

    std::optional<std::uint64_t> percentile_latency_ms(std::size_t pct) const;
    std::optional<std::uint64_t> p50_latency_ms() const { return percentile_latency_ms(50); }
    std::optional<std::uint64_t> p95_latency_ms() const { return percentile_latency_ms(95); }
    std::optional<std::uint64_t> p99_latency_ms() const { return percentile_latency_ms(99); }
    void record_latency(std::uint64_t sample_ms);
    void advance_time(std::int64_t now_ms);
};

struct RouteRequestPolicy {
    std::string idempotency_key;
    std::string required_auth_boundary = "workspace:default";
    ModelCapabilities required_capabilities{};
    std::uint64_t min_context_tokens = 0;
    std::uint64_t min_output_tokens = 0;
    std::uint8_t min_quality_tier = 1;
    TaskRisk task_risk = TaskRisk::Standard;
    PrivacyTier privacy_tier = PrivacyTier::ZeroDataRetention;
    std::vector<std::string> allowed_regions;
    std::optional<std::uint32_t> max_retention_hours;
    std::uint64_t estimated_input_tokens = 1024;
    std::uint64_t estimated_output_tokens = 512;
    std::optional<std::uint64_t> max_estimated_cost_microunits;
    std::optional<std::uint64_t> token_budget;
    EmergencyQuotaPolicy emergency_policy = EmergencyQuotaPolicy::deny();
    std::optional<std::int64_t> deadline_ms;
    std::optional<std::uint64_t> max_latency_p95_ms;
    std::vector<std::string> allowed_providers;
    std::vector<std::string> forbidden_providers;
    std::vector<std::string> allowed_models;
    std::vector<std::string> forbidden_models;
    std::vector<std::string> preferred_candidate_ids;
    FallbackScope fallback_scope = FallbackScope::SamePrivacyBoundary;
    bool cancelled = false;

    std::uint64_t estimated_total_tokens() const noexcept {
        const std::uint64_t sum = estimated_input_tokens + estimated_output_tokens;
        return sum == 0 ? 1 : sum;
    }
};

struct CandidateScoreBreakdown {
    std::string candidate_id;
    bool eligible = false;
    std::int64_t capability_fit_bps = 0;
    std::int64_t privacy_fit_bps = 0;
    std::int64_t budget_headroom_bps = 0;
    std::int64_t latency_health_bps = 0;
    std::int64_t reliability_bps = 0;
    std::int64_t user_preference_bps = 0;
    std::int64_t route_priority_bps = 0;
    std::int64_t total_score_bps = 0;
    std::vector<std::string> rejection_reasons;
};

enum class AcceptanceState : std::uint8_t {
    NotSent,
    Accepted,
    Unknown
};

enum class ReservationStatus : std::uint8_t {
    ReservedNotDispatched,
    InFlight,
    ReconciledCharged,
    ReconciledReleased,
    ReconciledUnknownUsage,
    OperatorRecoveryRequired,
    OrphanedOnRestart
};

struct ReservationGrant {
    std::string reservation_id;
    std::string candidate_id;
    std::string provider_id;
    std::string idempotency_key_hash;
    std::uint64_t reserved_tokens = 0;
    std::uint64_t reserved_cost_microunits = 0;
    std::string pricing_version;
    std::uint64_t candidate_epoch = 1;
    PrivacyTier policy_privacy_tier = PrivacyTier::ZeroDataRetention;
    ReservationStatus status = ReservationStatus::ReservedNotDispatched;
    std::optional<std::string> active_attempt_id;
    bool half_open_probe = false;
    std::int64_t created_at_ms = 0;
    std::int64_t updated_at_ms = 0;
};

struct RouteDecisionReceipt {
    std::uint32_t schema_version = 1;
    std::uint64_t sequence_id = 0;
    std::string receipt_id;
    std::string redaction_policy = "strict_no_secrets_no_prompts_no_raw_urls_v1";
    std::string idempotency_key_hash;
    std::string policy_class;
    std::string policy_hash;
    std::vector<CandidateScoreBreakdown> scores;
    std::optional<std::string> selected_candidate_id;
    std::optional<std::string> reservation_id;
    std::uint64_t reserved_tokens = 0;
    std::optional<std::uint64_t> estimated_cost_microunits;
    std::optional<std::int64_t> deadline_ms;
    std::int64_t decided_at_ms = 0;
    bool is_fallback = false;
    std::optional<std::string> parent_reservation_id;
};

struct ObservedUsage {
    bool known = false;
    std::uint64_t input_tokens = 0;
    std::uint64_t output_tokens = 0;

    static ObservedUsage make_known(std::uint64_t in_tok, std::uint64_t out_tok) {
        return {true, in_tok, out_tok};
    }
    static ObservedUsage usage_unknown() { return {false, 0, 0}; }
};

struct OutcomeReport {
    std::string reservation_id;
    std::string attempt_id;
    bool succeeded = true;
    bool timed_out = false;
    bool rate_limited = false;
    bool cancelled = false;
    AcceptanceState acceptance = AcceptanceState::Accepted;
    ObservedUsage usage = ObservedUsage::usage_unknown();
    std::optional<std::uint64_t> actual_cost_microunits;
    std::uint64_t latency_ms = 0;
    std::optional<std::int64_t> retry_after_ms;
    std::string diagnostic_note;
    std::int64_t now_ms = 0;
};

struct RouteOutcomeReceipt {
    std::uint32_t schema_version = 1;
    std::uint64_t sequence_id = 0;
    std::string receipt_id;
    std::string reservation_id;
    std::string attempt_id;
    std::string candidate_id;
    ReservationStatus resulting_status = ReservationStatus::ReconciledCharged;
    bool usage_known = false;
    std::uint64_t charged_tokens = 0;
    bool cost_known = false;
    std::uint64_t charged_cost_microunits = 0;
    std::uint64_t latency_ms = 0;
    bool fenced_late_outcome = false;
    std::string redacted_note;
    std::int64_t recorded_at_ms = 0;
};

struct DecisionResult {
    bool ok = false;
    RouteDecisionReceipt receipt;
    std::optional<ReservationGrant> grant;
};

struct CandidateSnapshot {
    RouteCandidate candidate;
    CandidateResourceState state;
};

std::string privacy_tier_to_string(PrivacyTier tier);
PrivacyTier parse_privacy_tier(std::string_view raw);
std::string quota_kind_to_string(QuotaState::Kind kind);
std::string circuit_kind_to_string(CircuitState::Kind kind);
std::string reservation_status_to_string(ReservationStatus status);

class DynamicProviderRouter {
public:
    DynamicProviderRouter() = default;

    void upsert_candidate(RouteCandidate candidate, CandidateResourceState state);
    bool set_candidate_enabled(std::string_view candidate_id, bool enabled);
    bool update_pricing_version(std::string_view candidate_id, std::string_view new_version);
    bool trip_circuit(std::string_view candidate_id, std::int64_t now_ms);
    bool reset_circuit(std::string_view candidate_id, std::int64_t now_ms);

    DecisionResult decide_and_reserve(
        const RouteRequestPolicy& policy,
        std::int64_t now_ms
    );

    DecisionResult decide_fallback(
        std::string_view failed_reservation_id,
        const RouteRequestPolicy& policy,
        std::int64_t now_ms
    );

    bool mark_dispatched(
        std::string_view reservation_id,
        std::string_view attempt_id,
        std::int64_t now_ms,
        std::string* out_error = nullptr
    );

    RouteOutcomeReceipt reconcile_outcome(const OutcomeReport& report);

    bool resolve_operator_recovery(
        std::string_view reservation_id,
        bool charge_reserved_tokens,
        std::int64_t now_ms
    );

    std::size_t recover_after_restart(std::int64_t now_ms);

    std::vector<CandidateSnapshot> snapshots(std::int64_t now_ms = 0) const;
    std::optional<ReservationGrant> reservation(std::string_view reservation_id) const;
    std::vector<RouteDecisionReceipt> decision_receipts() const;
    std::vector<RouteOutcomeReceipt> outcome_receipts() const;

private:
    mutable std::mutex mutex_;
    std::map<std::string, CandidateSnapshot, std::less<>> candidates_;
    std::map<std::string, ReservationGrant, std::less<>> reservations_;
    std::map<std::string, DecisionResult, std::less<>> idempotency_cache_;
    std::vector<RouteDecisionReceipt> decision_receipts_;
    std::vector<RouteOutcomeReceipt> outcome_receipts_;
    std::uint64_t seq_counter_ = 0;

    DecisionResult decide_internal(
        const RouteRequestPolicy& policy,
        std::int64_t now_ms,
        bool is_fallback,
        std::optional<std::string> parent_reservation_id,
        std::optional<std::string> excluded_candidate_id,
        std::optional< std::string > required_provider_id
    );
};

} // namespace omnia::routing
