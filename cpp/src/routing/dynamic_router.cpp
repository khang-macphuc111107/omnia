#include "omnia/routing/dynamic_router.hpp"
#include "omnia/core/redactor.hpp"
#include "omnia/core/sha256.hpp"

#include <algorithm>
#include <cctype>
#include <stdexcept>

namespace omnia::routing {

namespace {

constexpr std::size_t kMaxLatencySamples = 256;

std::string to_lower_ascii(std::string_view s) {
    std::string out(s);
    for (char& ch : out) {
        ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    }
    return out;
}

bool contains_exact(const std::vector<std::string>& vec, std::string_view target) {
    for (const auto& item : vec) {
        if (item == target) {
            return true;
        }
    }
    return false;
}

bool contains_icase(const std::vector<std::string>& vec, std::string_view target) {
    const std::string low_target = to_lower_ascii(target);
    for (const auto& item : vec) {
        if (to_lower_ascii(item) == low_target) {
            return true;
        }
    }
    return false;
}

std::string compute_policy_hash(const RouteRequestPolicy& p) {
    std::string canonical;
    canonical.reserve(256);
    canonical.append("auth=").append(p.required_auth_boundary);
    canonical.append("|priv=").append(privacy_tier_to_string(p.privacy_tier));
    canonical.append("|risk=").append(std::to_string(static_cast<int>(p.task_risk)));
    canonical.append("|in=").append(std::to_string(p.estimated_input_tokens));
    canonical.append("|out=").append(std::to_string(p.estimated_output_tokens));
    canonical.append("|caps=")
        .append(p.required_capabilities.text ? "1" : "0")
        .append(p.required_capabilities.vision ? "1" : "0")
        .append(p.required_capabilities.audio ? "1" : "0")
        .append(p.required_capabilities.tool_use ? "1" : "0")
        .append(p.required_capabilities.structured_output ? "1" : "0")
        .append(p.required_capabilities.streaming ? "1" : "0");
    return core::sha256_hex(canonical);
}

std::string make_policy_class(TaskRisk risk, PrivacyTier tier) {
    const char* risk_str = "standard";
    switch (risk) {
        case TaskRisk::Low: risk_str = "low"; break;
        case TaskRisk::Standard: risk_str = "standard"; break;
        case TaskRisk::High: risk_str = "high"; break;
        case TaskRisk::Critical: risk_str = "critical"; break;
    }
    return privacy_tier_to_string(tier) + ":" + risk_str;
}

} // namespace

std::string privacy_tier_to_string(PrivacyTier tier) {
    switch (tier) {
        case PrivacyTier::Public: return "public";
        case PrivacyTier::ZeroDataRetention: return "zero_data_retention";
        case PrivacyTier::PrivateVpc: return "private_vpc";
        case PrivacyTier::LocalOnly: return "local_only";
    }
    return "zero_data_retention";
}

PrivacyTier parse_privacy_tier(std::string_view raw) {
    const std::string low = to_lower_ascii(raw);
    if (low == "public" || low == "standard_cloud") return PrivacyTier::Public;
    if (low == "private_vpc" || low == "vpc") return PrivacyTier::PrivateVpc;
    if (low == "local_only" || low == "local" || low == "strict_local_zero_retention") {
        return PrivacyTier::LocalOnly;
    }
    return PrivacyTier::ZeroDataRetention;
}

std::string quota_kind_to_string(QuotaState::Kind kind) {
    switch (kind) {
        case QuotaState::Kind::Known: return "Known";
        case QuotaState::Kind::Unknown: return "Unknown";
        case QuotaState::Kind::Stale: return "Stale";
        case QuotaState::Kind::Contradictory: return "Contradictory";
    }
    return "Unknown";
}

std::string circuit_kind_to_string(CircuitState::Kind kind) {
    switch (kind) {
        case CircuitState::Kind::Closed: return "Closed";
        case CircuitState::Kind::Open: return "Open";
        case CircuitState::Kind::HalfOpen: return "HalfOpen";
    }
    return "Closed";
}

std::string reservation_status_to_string(ReservationStatus status) {
    switch (status) {
        case ReservationStatus::ReservedNotDispatched: return "reserved_not_dispatched";
        case ReservationStatus::InFlight: return "in_flight";
        case ReservationStatus::ReconciledCharged: return "reconciled_charged";
        case ReservationStatus::ReconciledReleased: return "reconciled_released";
        case ReservationStatus::ReconciledUnknownUsage: return "reconciled_unknown_usage";
        case ReservationStatus::OperatorRecoveryRequired: return "operator_recovery_required";
        case ReservationStatus::OrphanedOnRestart: return "orphaned_on_restart";
    }
    return "unknown";
}

std::optional<std::uint64_t> RouteCandidate::estimate_cost_microunits(
    std::uint64_t in_tokens,
    std::uint64_t out_tokens
) const noexcept {
    if (!input_cost_per_million_microunits.has_value() ||
        !output_cost_per_million_microunits.has_value()) {
        return std::nullopt;
    }
    const std::uint64_t in_rate = *input_cost_per_million_microunits;
    const std::uint64_t out_rate = *output_cost_per_million_microunits;
    const std::uint64_t in_cost = (in_tokens * in_rate + 999999ULL) / 1000000ULL;
    const std::uint64_t out_cost = (out_tokens * out_rate + 999999ULL) / 1000000ULL;
    return in_cost + out_cost;
}

std::optional<std::uint64_t> CandidateResourceState::percentile_latency_ms(
    std::size_t pct
) const {
    if (latency_samples_ms.empty()) {
        return std::nullopt;
    }
    std::vector<std::uint64_t> sorted = latency_samples_ms;
    std::sort(sorted.begin(), sorted.end());
    const std::size_t clamped = std::clamp<std::size_t>(pct, 1, 100);
    const std::size_t numer = sorted.size() * clamped + 99;
    const std::size_t idx = (numer / 100 > 0) ? (numer / 100 - 1) : 0;
    return sorted[std::min(idx, sorted.size() - 1)];
}

void CandidateResourceState::record_latency(std::uint64_t sample_ms) {
    if (latency_samples_ms.size() >= kMaxLatencySamples) {
        latency_samples_ms.erase(latency_samples_ms.begin());
    }
    latency_samples_ms.push_back(sample_ms);
    const double s = static_cast<double>(sample_ms);
    if (ewma_latency_ms.has_value()) {
        ewma_latency_ms = (*ewma_latency_ms) * 0.75 + s * 0.25;
    } else {
        ewma_latency_ms = s;
    }
}

void CandidateResourceState::advance_time(std::int64_t now_ms) {
    if (now_ms <= 0) {
        return;
    }
    if (circuit_state.kind == CircuitState::Kind::Open) {
        const std::int64_t ready_at =
            circuit_state.opened_at_ms + static_cast<std::int64_t>(circuit_state.cooldown_ms);
        if (now_ms >= ready_at) {
            circuit_state = CircuitState::half_open(false);
            ++circuit_transitions;
        }
    }
    if (retry_after_until_ms.has_value() && now_ms >= *retry_after_until_ms) {
        retry_after_until_ms.reset();
    }
    if (quota.kind == QuotaState::Kind::Known && quota.window_reset_at_ms > 0 &&
        now_ms >= quota.window_reset_at_ms) {
        if (quota.window_capacity_tokens.has_value() &&
            quota.window_duration_ms.has_value() &&
            *quota.window_duration_ms > 0) {
            const std::int64_t dur = *quota.window_duration_ms;
            const std::int64_t windows = ((now_ms - quota.window_reset_at_ms) / dur) + 1;
            quota.remaining_tokens = *quota.window_capacity_tokens;
            quota.window_reset_at_ms += windows * dur;
            freshness_ms = now_ms;
        } else {
            quota = QuotaState::make_stale(
                quota.remaining_tokens,
                freshness_ms,
                quota.window_reset_at_ms,
                quota.emergency_reserve_tokens
            );
        }
    }
    if (max_staleness_ms.has_value() && quota.kind == QuotaState::Kind::Known) {
        if (now_ms - freshness_ms > *max_staleness_ms) {
            quota = QuotaState::make_stale(
                quota.remaining_tokens,
                freshness_ms,
                freshness_ms + *max_staleness_ms,
                quota.emergency_reserve_tokens
            );
        }
    }
}

void DynamicProviderRouter::upsert_candidate(
    RouteCandidate candidate,
    CandidateResourceState state
) {
    if (candidate.candidate_id.empty()) {
        throw std::invalid_argument("RouteCandidate requires non-empty candidate_id");
    }
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = candidates_.find(candidate.candidate_id);
    if (it != candidates_.end()) {
        state.epoch = it->second.state.epoch + 1;
    }
    const std::string key = candidate.candidate_id;
    candidates_.insert_or_assign(
        key,
        CandidateSnapshot{std::move(candidate), std::move(state)}
    );
}

bool DynamicProviderRouter::set_candidate_enabled(
    std::string_view candidate_id,
    bool enabled
) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = candidates_.find(candidate_id);
    if (it == candidates_.end()) {
        return false;
    }
    it->second.candidate.enabled = enabled;
    ++it->second.state.epoch;
    return true;
}

bool DynamicProviderRouter::update_pricing_version(
    std::string_view candidate_id,
    std::string_view new_version
) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = candidates_.find(candidate_id);
    if (it == candidates_.end()) {
        return false;
    }
    it->second.candidate.pricing_version = std::string(new_version);
    ++it->second.state.epoch;
    return true;
}

bool DynamicProviderRouter::trip_circuit(std::string_view candidate_id, std::int64_t now_ms) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = candidates_.find(candidate_id);
    if (it == candidates_.end()) {
        return false;
    }
    auto& st = it->second.state;
    st.circuit_state = CircuitState::open(now_ms, st.circuit_cooldown_ms);
    st.consecutive_failures = st.circuit_failure_threshold;
    ++st.circuit_transitions;
    return true;
}

bool DynamicProviderRouter::reset_circuit(std::string_view candidate_id, std::int64_t now_ms) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = candidates_.find(candidate_id);
    if (it == candidates_.end()) {
        return false;
    }
    auto& st = it->second.state;
    st.circuit_state = CircuitState::closed();
    st.consecutive_failures = 0;
    st.retry_after_until_ms.reset();
    if (now_ms > 0) {
        st.freshness_ms = now_ms;
    }
    ++st.circuit_transitions;
    return true;
}

DecisionResult DynamicProviderRouter::decide_and_reserve(
    const RouteRequestPolicy& policy,
    std::int64_t now_ms
) {
    std::lock_guard<std::mutex> lock(mutex_);
    return decide_internal(policy, now_ms, false, std::nullopt, std::nullopt, std::nullopt);
}

DecisionResult DynamicProviderRouter::decide_fallback(
    std::string_view failed_reservation_id,
    const RouteRequestPolicy& policy,
    std::int64_t now_ms
) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = reservations_.find(failed_reservation_id);
    if (it == reservations_.end()) {
        throw std::invalid_argument("Unknown failed_reservation_id for fallback");
    }
    const ReservationGrant& prev = it->second;
    if (prev.status == ReservationStatus::InFlight ||
        prev.status == ReservationStatus::OperatorRecoveryRequired) {
        throw std::runtime_error(
            "Cannot dispatch fallback while prior reservation is unreconciled or in recovery"
        );
    }
    if (policy.fallback_scope == FallbackScope::None) {
        RouteDecisionReceipt rec{};
        rec.sequence_id = ++seq_counter_;
        rec.receipt_id = "rdec-" + std::to_string(rec.sequence_id);
        rec.idempotency_key_hash = core::sha256_hex(policy.idempotency_key);
        rec.policy_class = make_policy_class(policy.task_risk, policy.privacy_tier);
        rec.policy_hash = compute_policy_hash(policy);
        rec.decided_at_ms = now_ms;
        rec.is_fallback = true;
        rec.parent_reservation_id = std::string(failed_reservation_id);
        decision_receipts_.push_back(rec);
        return DecisionResult{false, std::move(rec), std::nullopt};
    }

    std::optional<std::string> req_provider;
    if (policy.fallback_scope == FallbackScope::SameProviderOnly) {
        req_provider = prev.provider_id;
    }

    RouteRequestPolicy fb_policy = policy;
    fb_policy.idempotency_key = policy.idempotency_key + ":fallback:" + prev.reservation_id;
    // Never downgrade privacy tier on fallback
    if (static_cast<std::uint8_t>(prev.policy_privacy_tier) >
        static_cast<std::uint8_t>(fb_policy.privacy_tier)) {
        fb_policy.privacy_tier = prev.policy_privacy_tier;
    }

    return decide_internal(
        fb_policy,
        now_ms,
        true,
        std::string(failed_reservation_id),
        prev.candidate_id,
        req_provider
    );
}

DecisionResult DynamicProviderRouter::decide_internal(
    const RouteRequestPolicy& policy,
    std::int64_t now_ms,
    bool is_fallback,
    std::optional<std::string> parent_reservation_id,
    std::optional<std::string> excluded_candidate_id,
    std::optional<std::string> required_provider_id
) {
    if (policy.idempotency_key.empty()) {
        throw std::invalid_argument("RouteRequestPolicy requires non-empty idempotency_key");
    }
    const auto cached_it = idempotency_cache_.find(policy.idempotency_key);
    if (cached_it != idempotency_cache_.end()) {
        return cached_it->second;
    }

    const std::uint64_t needed_tokens = policy.estimated_total_tokens();
    std::vector<CandidateScoreBreakdown> all_scores;
    all_scores.reserve(candidates_.size());

    struct EligiblePick {
        std::string candidate_id;
        std::int64_t total_score_bps = 0;
        std::optional<std::uint64_t> est_cost;
    };
    std::vector<EligiblePick> eligible;

    for (auto& [cid, snap] : candidates_) {
        snap.state.advance_time(now_ms);
        const auto& cand = snap.candidate;
        const auto& st = snap.state;

        CandidateScoreBreakdown bd{};
        bd.candidate_id = cid;

        if (policy.cancelled) {
            bd.rejection_reasons.push_back("request_cancelled");
        }
        if (excluded_candidate_id.has_value() && *excluded_candidate_id == cid) {
            bd.rejection_reasons.push_back("excluded_prior_attempt");
        }
        if (required_provider_id.has_value() && *required_provider_id != cand.provider_id) {
            bd.rejection_reasons.push_back("fallback_provider_scope_mismatch");
        }
        if (!cand.enabled) {
            bd.rejection_reasons.push_back("disabled");
        }
        if (cand.auth_boundary != policy.required_auth_boundary) {
            bd.rejection_reasons.push_back("unauthorized_boundary");
        }
        if (!cand.credential_present) {
            bd.rejection_reasons.push_back("missing_credential");
        }
        if (contains_exact(policy.forbidden_providers, cand.provider_id) ||
            contains_exact(policy.forbidden_models, cand.model_id)) {
            bd.rejection_reasons.push_back("forbidden_provider_or_model");
        }
        if (!policy.allowed_providers.empty() &&
            !contains_exact(policy.allowed_providers, cand.provider_id)) {
            bd.rejection_reasons.push_back("provider_not_in_allowed_set");
        }
        if (!policy.allowed_models.empty() &&
            !contains_exact(policy.allowed_models, cand.model_id)) {
            bd.rejection_reasons.push_back("model_not_in_allowed_set");
        }
        if (static_cast<std::uint8_t>(cand.privacy_tier) <
            static_cast<std::uint8_t>(policy.privacy_tier)) {
            bd.rejection_reasons.push_back("privacy_boundary_violation");
        }
        if (!policy.allowed_regions.empty() &&
            !contains_icase(policy.allowed_regions, cand.region)) {
            bd.rejection_reasons.push_back("region_violation");
        }
        if (policy.max_retention_hours.has_value() &&
            cand.retention_hours > *policy.max_retention_hours) {
            bd.rejection_reasons.push_back("retention_exceeded");
        }

        // Capabilities
        if (policy.required_capabilities.text && !cand.capabilities.text) {
            bd.rejection_reasons.push_back("missing_capability:text");
        }
        if (policy.required_capabilities.vision && !cand.capabilities.vision) {
            bd.rejection_reasons.push_back("missing_capability:vision");
        }
        if (policy.required_capabilities.audio && !cand.capabilities.audio) {
            bd.rejection_reasons.push_back("missing_capability:audio");
        }
        if (policy.required_capabilities.tool_use && !cand.capabilities.tool_use) {
            bd.rejection_reasons.push_back("missing_capability:tool_use");
        }
        if (policy.required_capabilities.structured_output && !cand.capabilities.structured_output) {
            bd.rejection_reasons.push_back("missing_capability:structured_output");
        }
        if (policy.required_capabilities.streaming && !cand.capabilities.streaming) {
            bd.rejection_reasons.push_back("missing_capability:streaming");
        }
        if (cand.capabilities.max_attachments < policy.required_capabilities.max_attachments) {
            bd.rejection_reasons.push_back("missing_capability:attachments");
        }
        const std::uint64_t req_ctx = std::max(policy.min_context_tokens, needed_tokens);
        if (cand.context_limit_tokens < req_ctx) {
            bd.rejection_reasons.push_back("context_limit_exceeded");
        }
        const std::uint64_t req_out = std::max(
            policy.min_output_tokens,
            policy.estimated_output_tokens
        );
        if (cand.max_output_tokens < req_out) {
            bd.rejection_reasons.push_back("output_limit_exceeded");
        }
        if (cand.quality_tier < policy.min_quality_tier) {
            bd.rejection_reasons.push_back("quality_below_target");
        }

        // Circuit & concurrency
        if (st.circuit_state.kind == CircuitState::Kind::Open) {
            bd.rejection_reasons.push_back("circuit_open");
        } else if (st.circuit_state.kind == CircuitState::Kind::HalfOpen &&
                   st.circuit_state.probe_in_flight) {
            bd.rejection_reasons.push_back("half_open_probe_busy");
        }
        if (st.retry_after_until_ms.has_value() && now_ms < *st.retry_after_until_ms) {
            bd.rejection_reasons.push_back("retry_after_active");
        }
        if (st.concurrent_reservations >= st.max_concurrency) {
            bd.rejection_reasons.push_back("concurrency_exhausted");
        }

        // Explicit Quota State Check (NEVER coerce Unknown/Stale/Contradictory to 0!)
        std::uint64_t usable_headroom = 0;
        switch (st.quota.kind) {
            case QuotaState::Kind::Unknown:
                bd.rejection_reasons.push_back("quota_unknown");
                break;
            case QuotaState::Kind::Contradictory:
                bd.rejection_reasons.push_back("quota_contradictory");
                break;
            case QuotaState::Kind::Stale: {
                if (policy.emergency_policy.mode == EmergencyQuotaMode::AllowStaleQuotaWithCap) {
                    const std::uint64_t avail = st.quota.remaining_tokens > st.reserved_tokens
                        ? (st.quota.remaining_tokens - st.reserved_tokens)
                        : 0;
                    if (needed_tokens > policy.emergency_policy.max_stale_tokens ||
                        needed_tokens > avail) {
                        bd.rejection_reasons.push_back("quota_stale_cap_exceeded");
                    } else {
                        usable_headroom = avail;
                    }
                } else {
                    bd.rejection_reasons.push_back("quota_stale");
                }
                break;
            }
            case QuotaState::Kind::Known: {
                const std::uint64_t avail = st.quota.remaining_tokens > st.reserved_tokens
                    ? (st.quota.remaining_tokens - st.reserved_tokens)
                    : 0;
                if (needed_tokens > avail) {
                    bd.rejection_reasons.push_back("quota_exhausted");
                } else {
                    const std::uint64_t standard_avail = avail > st.quota.emergency_reserve_tokens
                        ? (avail - st.quota.emergency_reserve_tokens)
                        : 0;
                    if (needed_tokens > standard_avail &&
                        policy.emergency_policy.mode != EmergencyQuotaMode::AllowEmergencyReserve) {
                        bd.rejection_reasons.push_back("emergency_reserve_protected");
                    } else {
                        usable_headroom = avail;
                    }
                }
                break;
            }
        }

        // Budget & latency limits
        if (policy.token_budget.has_value() && needed_tokens > *policy.token_budget) {
            bd.rejection_reasons.push_back("token_budget_exceeded");
        }
        const auto est_cost = cand.estimate_cost_microunits(
            policy.estimated_input_tokens,
            policy.estimated_output_tokens
        );
        if (policy.max_estimated_cost_microunits.has_value()) {
            if (!est_cost.has_value()) {
                bd.rejection_reasons.push_back("pricing_unknown_for_budget");
            } else if (*est_cost > *policy.max_estimated_cost_microunits) {
                bd.rejection_reasons.push_back("estimated_cost_exceeded");
            }
        }
        const auto p95 = st.p95_latency_ms();
        if (policy.max_latency_p95_ms.has_value() && p95.has_value() &&
            *p95 > *policy.max_latency_p95_ms) {
            bd.rejection_reasons.push_back("latency_budget_exceeded");
        }

        if (bd.rejection_reasons.empty()) {
            bd.eligible = true;
            bd.capability_fit_bps = 2000 + static_cast<std::int64_t>(cand.quality_tier) * 400;
            bd.privacy_fit_bps = 1500 +
                static_cast<std::int64_t>(cand.privacy_tier) * 500;
            bd.budget_headroom_bps = static_cast<std::int64_t>(
                std::min<std::uint64_t>(2500, usable_headroom / 500)
            );
            const double lat = st.ewma_latency_ms.value_or(250.0);
            bd.latency_health_bps = std::max<std::int64_t>(
                200,
                2500 - static_cast<std::int64_t>(lat * 2.0)
            );
            const std::uint64_t total_calls = st.success_count + st.error_count + st.timeout_count;
            if (total_calls == 0) {
                bd.reliability_bps = 1800;
            } else {
                bd.reliability_bps = static_cast<std::int64_t>(
                    (st.success_count * 2500ULL) / total_calls
                );
            }
            for (std::size_t idx = 0; idx < policy.preferred_candidate_ids.size(); ++idx) {
                if (policy.preferred_candidate_ids[idx] == cid) {
                    bd.user_preference_bps = static_cast<std::int64_t>(
                        1500 - std::min<std::size_t>(idx * 300, 1200)
                    );
                    break;
                }
            }
            bd.route_priority_bps = static_cast<std::int64_t>(cand.route_priority) * 100;
            bd.total_score_bps = bd.capability_fit_bps + bd.privacy_fit_bps +
                bd.budget_headroom_bps + bd.latency_health_bps + bd.reliability_bps +
                bd.user_preference_bps + bd.route_priority_bps;

            eligible.push_back(EligiblePick{cid, bd.total_score_bps, est_cost});
        }
        all_scores.push_back(std::move(bd));
    }

    // Deterministic tie-break: descending total_score_bps, then ascending candidate_id
    std::sort(
        eligible.begin(),
        eligible.end(),
        [](const EligiblePick& a, const EligiblePick& b) {
            if (a.total_score_bps != b.total_score_bps) {
                return a.total_score_bps > b.total_score_bps;
            }
            return a.candidate_id < b.candidate_id;
        }
    );

    RouteDecisionReceipt receipt{};
    receipt.sequence_id = ++seq_counter_;
    receipt.receipt_id = "rdec-" + std::to_string(receipt.sequence_id);
    receipt.idempotency_key_hash = core::sha256_hex(policy.idempotency_key);
    receipt.policy_class = make_policy_class(policy.task_risk, policy.privacy_tier);
    receipt.policy_hash = compute_policy_hash(policy);
    receipt.scores = std::move(all_scores);
    receipt.deadline_ms = policy.deadline_ms;
    receipt.decided_at_ms = now_ms;
    receipt.is_fallback = is_fallback;
    receipt.parent_reservation_id = std::move(parent_reservation_id);

    DecisionResult result{};
    if (eligible.empty()) {
        result.ok = false;
        result.receipt = receipt;
        decision_receipts_.push_back(receipt);
        idempotency_cache_.insert_or_assign(policy.idempotency_key, result);
        return result;
    }

    const EligiblePick& winner = eligible.front();
    auto& win_snap = candidates_.at(winner.candidate_id);
    const std::uint64_t est_cost_val = winner.est_cost.value_or(0);
    const bool is_probe = (win_snap.state.circuit_state.kind == CircuitState::Kind::HalfOpen);

    win_snap.state.reserved_tokens += needed_tokens;
    win_snap.state.reserved_cost_microunits += est_cost_val;
    ++win_snap.state.concurrent_reservations;
    if (is_probe) {
        win_snap.state.circuit_state.probe_in_flight = true;
    }

    const std::string res_id = "resv-" + std::to_string(receipt.sequence_id);
    ReservationGrant grant{};
    grant.reservation_id = res_id;
    grant.candidate_id = winner.candidate_id;
    grant.provider_id = win_snap.candidate.provider_id;
    grant.idempotency_key_hash = receipt.idempotency_key_hash;
    grant.reserved_tokens = needed_tokens;
    grant.reserved_cost_microunits = est_cost_val;
    grant.pricing_version = win_snap.candidate.pricing_version;
    grant.candidate_epoch = win_snap.state.epoch;
    grant.policy_privacy_tier = policy.privacy_tier;
    grant.status = ReservationStatus::ReservedNotDispatched;
    grant.half_open_probe = is_probe;
    grant.created_at_ms = now_ms;
    grant.updated_at_ms = now_ms;

    reservations_.insert_or_assign(res_id, grant);

    receipt.selected_candidate_id = winner.candidate_id;
    receipt.reservation_id = res_id;
    receipt.reserved_tokens = needed_tokens;
    receipt.estimated_cost_microunits = winner.est_cost;

    decision_receipts_.push_back(receipt);
    result.ok = true;
    result.receipt = std::move(receipt);
    result.grant = std::move(grant);
    idempotency_cache_.insert_or_assign(policy.idempotency_key, result);
    return result;
}

bool DynamicProviderRouter::mark_dispatched(
    std::string_view reservation_id,
    std::string_view attempt_id,
    std::int64_t now_ms,
    std::string* out_error
) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto res_it = reservations_.find(reservation_id);
    if (res_it == reservations_.end()) {
        if (out_error != nullptr) *out_error = "unknown_reservation";
        return false;
    }
    auto& grant = res_it->second;
    if (grant.status != ReservationStatus::ReservedNotDispatched) {
        if (out_error != nullptr) *out_error = "invalid_reservation_state_for_dispatch";
        return false;
    }
    auto cand_it = candidates_.find(grant.candidate_id);
    if (cand_it == candidates_.end()) {
        if (out_error != nullptr) *out_error = "candidate_removed";
        return false;
    }
    auto& snap = cand_it->second;
    if (!snap.candidate.enabled ||
        snap.candidate.pricing_version != grant.pricing_version ||
        snap.state.epoch != grant.candidate_epoch) {
        // Release held reservation cleanly on registry/pricing drift
        snap.state.reserved_tokens = snap.state.reserved_tokens > grant.reserved_tokens
            ? (snap.state.reserved_tokens - grant.reserved_tokens)
            : 0;
        snap.state.reserved_cost_microunits =
            snap.state.reserved_cost_microunits > grant.reserved_cost_microunits
            ? (snap.state.reserved_cost_microunits - grant.reserved_cost_microunits)
            : 0;
        if (snap.state.concurrent_reservations > 0) {
            --snap.state.concurrent_reservations;
        }
        if (grant.half_open_probe) {
            snap.state.circuit_state.probe_in_flight = false;
        }
        grant.status = ReservationStatus::ReconciledReleased;
        grant.updated_at_ms = now_ms;
        if (out_error != nullptr) *out_error = "registry_or_pricing_drift_fenced";
        return false;
    }

    grant.status = ReservationStatus::InFlight;
    grant.active_attempt_id = std::string(attempt_id);
    grant.updated_at_ms = now_ms;
    return true;
}

RouteOutcomeReceipt DynamicProviderRouter::reconcile_outcome(const OutcomeReport& report) {
    std::lock_guard<std::mutex> lock(mutex_);
    RouteOutcomeReceipt out{};
    out.sequence_id = ++seq_counter_;
    out.receipt_id = "rout-" + std::to_string(out.sequence_id);
    out.reservation_id = report.reservation_id;
    out.attempt_id = report.attempt_id;
    out.latency_ms = report.latency_ms;
    out.redacted_note = core::SecretRedactor::redact(report.diagnostic_note);
    out.recorded_at_ms = report.now_ms;

    auto res_it = reservations_.find(report.reservation_id);
    if (res_it == reservations_.end()) {
        out.fenced_late_outcome = true;
        outcome_receipts_.push_back(out);
        return out;
    }

    auto& grant = res_it->second;
    out.candidate_id = grant.candidate_id;

    // Fence already reconciled or mismatched attempt IDs
    const bool terminal =
        grant.status == ReservationStatus::ReconciledCharged ||
        grant.status == ReservationStatus::ReconciledReleased ||
        grant.status == ReservationStatus::ReconciledUnknownUsage ||
        grant.status == ReservationStatus::OrphanedOnRestart;

    const bool attempt_mismatch =
        grant.active_attempt_id.has_value() &&
        !report.attempt_id.empty() &&
        (*grant.active_attempt_id != report.attempt_id);

    if (terminal || attempt_mismatch) {
        out.resulting_status = grant.status;
        out.fenced_late_outcome = true;
        outcome_receipts_.push_back(out);
        return out;
    }

    auto cand_it = candidates_.find(grant.candidate_id);
    if (cand_it == candidates_.end()) {
        out.fenced_late_outcome = true;
        outcome_receipts_.push_back(out);
        return out;
    }
    auto& snap = cand_it->second;
    auto& st = snap.state;

    if (report.latency_ms > 0) {
        st.record_latency(report.latency_ms);
    }
    if (report.retry_after_ms.has_value() && *report.retry_after_ms > 0) {
        st.retry_after_until_ms = report.now_ms + *report.retry_after_ms;
    }

    // Unknown remote acceptance -> OperatorRecoveryRequired (retain token hold safely!)
    if (report.acceptance == AcceptanceState::Unknown) {
        if (st.concurrent_reservations > 0) {
            --st.concurrent_reservations;
        }
        if (grant.half_open_probe) {
            st.circuit_state = CircuitState::open(report.now_ms, st.circuit_cooldown_ms);
            ++st.circuit_transitions;
        }
        grant.status = ReservationStatus::OperatorRecoveryRequired;
        grant.updated_at_ms = report.now_ms;
        out.resulting_status = grant.status;
        outcome_receipts_.push_back(out);
        return out;
    }

    // Release active reservation hold before applying final charge/release
    st.reserved_tokens = st.reserved_tokens > grant.reserved_tokens
        ? (st.reserved_tokens - grant.reserved_tokens)
        : 0;
    st.reserved_cost_microunits = st.reserved_cost_microunits > grant.reserved_cost_microunits
        ? (st.reserved_cost_microunits - grant.reserved_cost_microunits)
        : 0;
    if (st.concurrent_reservations > 0) {
        --st.concurrent_reservations;
    }

    if (!report.succeeded || report.acceptance == AcceptanceState::NotSent) {
        if (report.timed_out) {
            ++st.timeout_count;
        } else {
            ++st.error_count;
        }
        ++st.consecutive_failures;
        if (st.circuit_state.kind == CircuitState::Kind::HalfOpen ||
            st.consecutive_failures >= st.circuit_failure_threshold) {
            st.circuit_state = CircuitState::open(report.now_ms, st.circuit_cooldown_ms);
            ++st.circuit_transitions;
        }

        if (report.acceptance == AcceptanceState::NotSent) {
            grant.status = ReservationStatus::ReconciledReleased;
        } else if (report.usage.known) {
            const std::uint64_t used = report.usage.input_tokens + report.usage.output_tokens;
            if (st.quota.kind == QuotaState::Kind::Known) {
                st.quota.remaining_tokens = st.quota.remaining_tokens > used
                    ? (st.quota.remaining_tokens - used)
                    : 0;
            }
            out.usage_known = true;
            out.charged_tokens = used;
            grant.status = ReservationStatus::ReconciledCharged;
        } else {
            grant.status = ReservationStatus::ReconciledReleased;
        }
        grant.updated_at_ms = report.now_ms;
        out.resulting_status = grant.status;
        outcome_receipts_.push_back(out);
        return out;
    }

    // Succeeded path
    ++st.success_count;
    st.consecutive_failures = 0;
    if (st.circuit_state.kind == CircuitState::Kind::HalfOpen) {
        st.circuit_state = CircuitState::closed();
        ++st.circuit_transitions;
    }

    if (report.usage.known) {
        const std::uint64_t used = report.usage.input_tokens + report.usage.output_tokens;
        if (st.quota.kind == QuotaState::Kind::Known) {
            st.quota.remaining_tokens = st.quota.remaining_tokens > used
                ? (st.quota.remaining_tokens - used)
                : 0;
        }
        out.usage_known = true;
        out.charged_tokens = used;

        if (report.actual_cost_microunits.has_value()) {
            out.cost_known = true;
            out.charged_cost_microunits = *report.actual_cost_microunits;
            st.reconciled_cost_microunits += *report.actual_cost_microunits;
        } else if (const auto est = snap.candidate.estimate_cost_microunits(
                       report.usage.input_tokens,
                       report.usage.output_tokens
                   ); est.has_value()) {
            out.cost_known = true;
            out.charged_cost_microunits = *est;
            st.reconciled_cost_microunits += *est;
        }
        grant.status = ReservationStatus::ReconciledCharged;
    } else {
        // Explicit unknown usage: NEVER coerce to 0! Deduct conservative reservation
        // from Known quota and increment unknown_usage_count explicitly.
        ++st.unknown_usage_count;
        if (st.quota.kind == QuotaState::Kind::Known) {
            st.quota.remaining_tokens = st.quota.remaining_tokens > grant.reserved_tokens
                ? (st.quota.remaining_tokens - grant.reserved_tokens)
                : 0;
        }
        out.usage_known = false;
        out.charged_tokens = grant.reserved_tokens;
        grant.status = ReservationStatus::ReconciledUnknownUsage;
    }

    grant.updated_at_ms = report.now_ms;
    out.resulting_status = grant.status;
    outcome_receipts_.push_back(out);
    return out;
}

bool DynamicProviderRouter::resolve_operator_recovery(
    std::string_view reservation_id,
    bool charge_reserved_tokens,
    std::int64_t now_ms
) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto res_it = reservations_.find(reservation_id);
    if (res_it == reservations_.end() ||
        res_it->second.status != ReservationStatus::OperatorRecoveryRequired) {
        return false;
    }
    auto& grant = res_it->second;
    auto cand_it = candidates_.find(grant.candidate_id);
    if (cand_it != candidates_.end()) {
        auto& st = cand_it->second.state;
        st.reserved_tokens = st.reserved_tokens > grant.reserved_tokens
            ? (st.reserved_tokens - grant.reserved_tokens)
            : 0;
        st.reserved_cost_microunits = st.reserved_cost_microunits > grant.reserved_cost_microunits
            ? (st.reserved_cost_microunits - grant.reserved_cost_microunits)
            : 0;
        if (charge_reserved_tokens && st.quota.kind == QuotaState::Kind::Known) {
            st.quota.remaining_tokens = st.quota.remaining_tokens > grant.reserved_tokens
                ? (st.quota.remaining_tokens - grant.reserved_tokens)
                : 0;
        }
    }
    grant.status = charge_reserved_tokens
        ? ReservationStatus::ReconciledCharged
        : ReservationStatus::ReconciledReleased;
    grant.updated_at_ms = now_ms;
    return true;
}

std::size_t DynamicProviderRouter::recover_after_restart(std::int64_t now_ms) {
    std::lock_guard<std::mutex> lock(mutex_);
    std::size_t affected = 0;
    for (auto& [res_id, grant] : reservations_) {
        (void)res_id;
        if (grant.status == ReservationStatus::ReservedNotDispatched) {
            auto cand_it = candidates_.find(grant.candidate_id);
            if (cand_it != candidates_.end()) {
                auto& st = cand_it->second.state;
                st.reserved_tokens = st.reserved_tokens > grant.reserved_tokens
                    ? (st.reserved_tokens - grant.reserved_tokens)
                    : 0;
                st.reserved_cost_microunits =
                    st.reserved_cost_microunits > grant.reserved_cost_microunits
                    ? (st.reserved_cost_microunits - grant.reserved_cost_microunits)
                    : 0;
                if (st.concurrent_reservations > 0) {
                    --st.concurrent_reservations;
                }
                if (grant.half_open_probe) {
                    st.circuit_state.probe_in_flight = false;
                }
            }
            grant.status = ReservationStatus::OrphanedOnRestart;
            grant.updated_at_ms = now_ms;
            ++affected;
        } else if (grant.status == ReservationStatus::InFlight) {
            auto cand_it = candidates_.find(grant.candidate_id);
            if (cand_it != candidates_.end()) {
                auto& st = cand_it->second.state;
                if (st.concurrent_reservations > 0) {
                    --st.concurrent_reservations;
                }
                if (grant.half_open_probe) {
                    st.circuit_state.probe_in_flight = false;
                }
            }
            grant.status = ReservationStatus::OperatorRecoveryRequired;
            grant.updated_at_ms = now_ms;
            ++affected;
        }
    }
    return affected;
}

std::vector<CandidateSnapshot> DynamicProviderRouter::snapshots(std::int64_t now_ms) const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<CandidateSnapshot> out;
    out.reserve(candidates_.size());
    for (const auto& [cid, snap] : candidates_) {
        (void)cid;
        CandidateSnapshot copy = snap;
        if (now_ms > 0) {
            copy.state.advance_time(now_ms);
        }
        out.push_back(std::move(copy));
    }
    return out;
}

std::optional<ReservationGrant> DynamicProviderRouter::reservation(
    std::string_view reservation_id
) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = reservations_.find(reservation_id);
    if (it != reservations_.end()) {
        return it->second;
    }
    return std::nullopt;
}

std::vector<RouteDecisionReceipt> DynamicProviderRouter::decision_receipts() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return decision_receipts_;
}

std::vector<RouteOutcomeReceipt> DynamicProviderRouter::outcome_receipts() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return outcome_receipts_;
}

} // namespace omnia::routing
