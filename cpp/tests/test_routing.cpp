#include "test_support.hpp"

#include "omnia/routing/dynamic_router.hpp"

#include <iostream>
#include <limits>
#include <thread>
#include <vector>

namespace {

using namespace omnia::routing;

void test_quota_truth_and_tie_break() {
    DynamicProviderRouter router;

    // Unknown, Stale, and Contradictory candidates must NEVER be coerced to 0 or selected by default
    RouteCandidate c_unknown{};
    c_unknown.candidate_id = "01-unknown";
    c_unknown.provider_id = "prov-u";
    c_unknown.model_id = "m-u";
    CandidateResourceState s_unknown{};
    s_unknown.quota = QuotaState::make_unknown("no_telemetry");
    router.upsert_candidate(c_unknown, s_unknown);

    RouteCandidate c_stale{};
    c_stale.candidate_id = "02-stale";
    c_stale.provider_id = "prov-s";
    c_stale.model_id = "m-s";
    CandidateResourceState s_stale{};
    s_stale.quota = QuotaState::make_stale(500000, 1000, 2000, 5000);
    router.upsert_candidate(c_stale, s_stale);

    RouteCandidate c_contra{};
    c_contra.candidate_id = "03-contra";
    c_contra.provider_id = "prov-c";
    c_contra.model_id = "m-c";
    CandidateResourceState s_contra{};
    s_contra.quota = QuotaState::make_contradictory("negative_remaining_reported");
    router.upsert_candidate(c_contra, s_contra);

    RouteRequestPolicy pol{};
    pol.idempotency_key = "idem-1";
    const auto fail_dec = router.decide_and_reserve(pol, 5000);
    OMNIA_CHECK(!fail_dec.ok);

    // Add two identically scored Known candidates to verify deterministic ascending candidate_id tie-break
    for (const char* id : {"cand-zeta", "cand-alpha"}) {
        RouteCandidate c{};
        c.candidate_id = id;
        c.provider_id = "prov-good";
        c.model_id = "m-good";
        CandidateResourceState s{};
        s.quota = QuotaState::make_known(100000, 20000, 90000);
        s.freshness_ms = 5000;
        s.ewma_latency_ms = 200.0;
        router.upsert_candidate(c, s);
    }

    pol.idempotency_key = "idem-tiebreak";
    const auto win_dec = router.decide_and_reserve(pol, 5000);
    OMNIA_CHECK(win_dec.ok);
    OMNIA_CHECK(win_dec.receipt.selected_candidate_id.value_or("") == "cand-alpha");

    // Idempotent duplicate dispatch must NOT double-reserve tokens
    const auto dup_dec = router.decide_and_reserve(pol, 5010);
    OMNIA_CHECK(dup_dec.ok);
    OMNIA_CHECK(dup_dec.receipt.reservation_id == win_dec.receipt.reservation_id);

    // Emergency reserve protection check
    RouteRequestPolicy big_pol{};
    big_pol.idempotency_key = "idem-emergency-blocked";
    big_pol.estimated_input_tokens = 80000;
    big_pol.estimated_output_tokens = 5000; // 85000 > (100000 - 20000 emergency reserve)
    big_pol.allowed_models = {"m-good"};
    OMNIA_CHECK(!router.decide_and_reserve(big_pol, 5020).ok);

    big_pol.idempotency_key = "idem-emergency-admitted";
    big_pol.emergency_policy = EmergencyQuotaPolicy::allow_emergency_reserve();
    OMNIA_CHECK(router.decide_and_reserve(big_pol, 5030).ok);
}

void test_circuit_fencing_and_recovery() {
    DynamicProviderRouter router;

    RouteCandidate c{};
    c.candidate_id = "primary-zdr";
    c.provider_id = "anthropic";
    c.model_id = "claude-opus-4-6";
    c.privacy_tier = PrivacyTier::ZeroDataRetention;
    CandidateResourceState s{};
    s.quota = QuotaState::make_known(500000, 10000, 900000);
    s.circuit_failure_threshold = 2;
    s.circuit_cooldown_ms = 5000;
    s.freshness_ms = 1000;
    router.upsert_candidate(c, s);

    // Trip circuit after 2 consecutive failures
    for (int i = 1; i <= 2; ++i) {
        RouteRequestPolicy pol{};
        pol.idempotency_key = "fail-" + std::to_string(i);
        const auto d = router.decide_and_reserve(pol, 1000 + i * 10);
        OMNIA_CHECK(d.ok && d.grant.has_value());
        OMNIA_CHECK(router.mark_dispatched(d.grant->reservation_id, "att-" + std::to_string(i), 1050));

        OutcomeReport rep{};
        rep.reservation_id = d.grant->reservation_id;
        rep.attempt_id = "att-" + std::to_string(i);
        rep.succeeded = false;
        rep.timed_out = true;
        rep.acceptance = AcceptanceState::Accepted;
        rep.diagnostic_note = "Upstream key " + std::string("sk") + "-" + std::string(16, 'Q');
        rep.now_ms = 1100 + i * 10;
        const auto out = router.reconcile_outcome(rep);
        OMNIA_CHECK(out.redacted_note.find("[REDACTED_SECRET]") != std::string::npos);

        // Late duplicate outcome on same attempt must be fenced
        const auto late = router.reconcile_outcome(rep);
        OMNIA_CHECK(late.fenced_late_outcome);
    }

    // Circuit is now Open at t=2000 -> rejected!
    RouteRequestPolicy blocked_pol{};
    blocked_pol.idempotency_key = "while-open";
    OMNIA_CHECK(!router.decide_and_reserve(blocked_pol, 2000).ok);

    // Advance past cooldown (1120 + 5000 = 6120) -> HalfOpen admits exactly 1 probe
    RouteRequestPolicy probe_pol{};
    probe_pol.idempotency_key = "half-open-probe-1";
    const auto probe1 = router.decide_and_reserve(probe_pol, 7000);
    OMNIA_CHECK(probe1.ok && probe1.grant.has_value());

    RouteRequestPolicy probe2_pol{};
    probe2_pol.idempotency_key = "half-open-probe-2";
    OMNIA_CHECK(!router.decide_and_reserve(probe2_pol, 7005).ok); // HalfOpen probe busy!

    // Probe succeeds -> Circuit returns to Closed!
    OMNIA_CHECK(router.mark_dispatched(probe1.grant->reservation_id, "att-probe", 7010));
    OutcomeReport ok_rep{};
    ok_rep.reservation_id = probe1.grant->reservation_id;
    ok_rep.attempt_id = "att-probe";
    ok_rep.succeeded = true;
    ok_rep.acceptance = AcceptanceState::Accepted;
    ok_rep.usage = ObservedUsage::make_known(900, 400);
    ok_rep.latency_ms = 220;
    ok_rep.now_ms = 7230;
    (void)router.reconcile_outcome(ok_rep);
    OMNIA_CHECK(router.snapshots(7240).front().state.circuit_state.kind == CircuitState::Kind::Closed);

    // Registry pricing drift before dispatch fences mark_dispatched
    RouteRequestPolicy drift_pol{};
    drift_pol.idempotency_key = "drift-check";
    const auto drift_dec = router.decide_and_reserve(drift_pol, 7300);
    OMNIA_CHECK(drift_dec.ok);
    OMNIA_CHECK(router.update_pricing_version("primary-zdr", "v2-drifted"));
    std::string drift_err;
    OMNIA_CHECK(!router.mark_dispatched(drift_dec.grant->reservation_id, "att-drift", 7310, &drift_err));
    OMNIA_CHECK(drift_err == "registry_or_pricing_drift_fenced");

    // AcceptanceState::Unknown -> OperatorRecoveryRequired
    RouteRequestPolicy unk_pol{};
    unk_pol.idempotency_key = "unknown-acceptance";
    const auto unk_dec = router.decide_and_reserve(unk_pol, 7400);
    OMNIA_CHECK(unk_dec.ok);
    OMNIA_CHECK(router.mark_dispatched(unk_dec.grant->reservation_id, "att-unk", 7410));
    OutcomeReport unk_rep{};
    unk_rep.reservation_id = unk_dec.grant->reservation_id;
    unk_rep.attempt_id = "att-unk";
    unk_rep.succeeded = false;
    unk_rep.acceptance = AcceptanceState::Unknown;
    unk_rep.now_ms = 7500;
    const auto unk_out = router.reconcile_outcome(unk_rep);
    OMNIA_CHECK(unk_out.resulting_status == ReservationStatus::OperatorRecoveryRequired);
    OMNIA_CHECK(router.resolve_operator_recovery(unk_dec.grant->reservation_id, false, 7600));

    // Restart recovery: ReservedNotDispatched -> OrphanedOnRestart, InFlight -> OperatorRecoveryRequired
    RouteRequestPolicy r1{};
    r1.idempotency_key = "restart-not-sent";
    const auto d_r1 = router.decide_and_reserve(r1, 8000);
    RouteRequestPolicy r2{};
    r2.idempotency_key = "restart-in-flight";
    const auto d_r2 = router.decide_and_reserve(r2, 8010);
    OMNIA_CHECK(router.mark_dispatched(d_r2.grant->reservation_id, "att-r2", 8020));

    OMNIA_CHECK(router.recover_after_restart(9000) == 2);
    OMNIA_CHECK(router.reservation(d_r1.grant->reservation_id)->status == ReservationStatus::OrphanedOnRestart);
    OMNIA_CHECK(router.reservation(d_r2.grant->reservation_id)->status == ReservationStatus::OperatorRecoveryRequired);
}

void test_concurrent_reservations() {
    DynamicProviderRouter router;
    RouteCandidate c{};
    c.candidate_id = "concurrent-node";
    c.provider_id = "local";
    c.model_id = "local-model";
    c.privacy_tier = PrivacyTier::LocalOnly;
    CandidateResourceState s{};
    s.quota = QuotaState::make_known(100000, 0, 999999);
    s.max_concurrency = 64;
    router.upsert_candidate(c, s);

    std::vector<std::thread> threads;
    for (int t = 0; t < 8; ++t) {
        threads.emplace_back([&router, t]() {
            for (int k = 0; k < 5; ++k) {
                RouteRequestPolicy p{};
                p.idempotency_key = "thr-" + std::to_string(t) + "-" + std::to_string(k);
                p.privacy_tier = PrivacyTier::LocalOnly;
                p.estimated_input_tokens = 1000;
                p.estimated_output_tokens = 500;
                const auto res = router.decide_and_reserve(p, 10000);
                OMNIA_CHECK(res.ok);
            }
        });
    }
    for (auto& th : threads) th.join();
    OMNIA_CHECK(router.snapshots().front().state.reserved_tokens == 8ULL * 5ULL * 1500ULL);
}

void test_simulation_and_deadline_fences() {
    DynamicProviderRouter router;
    RouteCandidate candidate{};
    candidate.candidate_id = "sim-candidate";
    candidate.provider_id = "local";
    candidate.model_id = "sim-model";
    candidate.privacy_tier = PrivacyTier::LocalOnly;
    CandidateResourceState state{};
    state.quota = QuotaState::make_known(100000, 0, 999999);
    router.upsert_candidate(candidate, state);

    RouteCandidate fallback_candidate = candidate;
    fallback_candidate.candidate_id = "sim-fallback";
    CandidateResourceState fallback_state{};
    fallback_state.quota = QuotaState::make_known(100000, 0, 999999);
    router.upsert_candidate(fallback_candidate, fallback_state);

    RouteRequestPolicy sim{};
    sim.idempotency_key = "simulation-only";
    sim.privacy_tier = PrivacyTier::LocalOnly;
    sim.simulate = true;
    const auto before = router.snapshots().front().state;
    const auto receipts_before = router.decision_receipts().size();
    const auto first = router.decide_and_reserve(sim, 1000);
    const auto second = router.decide_and_reserve(sim, 1000);
    OMNIA_CHECK(first.ok && second.ok);
    OMNIA_CHECK(first.receipt.simulated && second.receipt.simulated);
    OMNIA_CHECK(first.receipt.sequence_id == 0 && second.receipt.sequence_id == 0);
    OMNIA_CHECK(first.receipt.receipt_id == second.receipt.receipt_id);
    OMNIA_CHECK(router.decision_receipts().size() == receipts_before);
    const auto after = router.snapshots().front().state;
    OMNIA_CHECK(after.reserved_tokens == before.reserved_tokens);
    OMNIA_CHECK(after.concurrent_reservations == before.concurrent_reservations);
    OMNIA_CHECK(after.circuit_transitions == before.circuit_transitions);

    RouteRequestPolicy real{};
    real.idempotency_key = "deadline-parent";
    real.privacy_tier = PrivacyTier::LocalOnly;
    real.deadline_ms = 3000;
    const auto parent = router.decide_and_reserve(real, 1000);
    OMNIA_CHECK(parent.ok && parent.grant.has_value());
    RouteRequestPolicy fallback = real;
    fallback.idempotency_key = "deadline-fallback";
    fallback.deadline_ms = 9000;
    fallback.fallback_scope = FallbackScope::SamePrivacyBoundary;
    const auto continued = router.decide_fallback(parent.grant->reservation_id, fallback, 2000);
    OMNIA_CHECK(continued.ok && continued.grant.has_value());
    OMNIA_CHECK(continued.grant->candidate_id == "sim-fallback");
    OMNIA_CHECK(continued.grant->deadline_ms == real.deadline_ms);
    std::string dispatch_error;
    OMNIA_CHECK(!router.mark_dispatched(
        continued.grant->reservation_id,
        "late-fallback-at-deadline",
        3000,
        &dispatch_error
    ));
    OMNIA_CHECK(dispatch_error == "reservation_deadline_expired");

    RouteRequestPolicy scoped_parent = real;
    scoped_parent.idempotency_key = "fallback-disjoint-parent";
    scoped_parent.deadline_ms = 9000;
    scoped_parent.allowed_regions = {"us"};
    const auto scoped = router.decide_and_reserve(scoped_parent, 4000);
    OMNIA_CHECK(scoped.ok && scoped.grant.has_value());
    RouteRequestPolicy disjoint = scoped_parent;
    disjoint.idempotency_key = "fallback-disjoint-child";
    disjoint.allowed_regions = {"eu"};
    OMNIA_CHECK_THROWS(router.decide_fallback(scoped.grant->reservation_id, disjoint, 4500));

    // Admission rejects expired deadlines and checked token arithmetic never
    // wraps into a small reservation.  These failures must leave router state
    // unchanged because neither request reached candidate selection.
    const auto before_invalid = router.snapshots();
    RouteRequestPolicy expired = real;
    expired.idempotency_key = "expired-direct";
    expired.deadline_ms = 5000;
    OMNIA_CHECK_THROWS(router.decide_and_reserve(expired, 5000));
    RouteRequestPolicy overflowing = real;
    overflowing.idempotency_key = "overflow-direct";
    overflowing.estimated_input_tokens = std::numeric_limits<std::uint64_t>::max();
    overflowing.estimated_output_tokens = 1;
    OMNIA_CHECK_THROWS(router.decide_and_reserve(overflowing, 4500));
    const auto after_invalid = router.snapshots();
    OMNIA_CHECK(after_invalid.size() == before_invalid.size());
    OMNIA_CHECK(after_invalid.front().state.reserved_tokens ==
        before_invalid.front().state.reserved_tokens);

    RouteCandidate cost_probe{};
    cost_probe.input_cost_per_million_microunits = std::numeric_limits<std::uint64_t>::max();
    cost_probe.output_cost_per_million_microunits = std::numeric_limits<std::uint64_t>::max();
    OMNIA_CHECK(!cost_probe.estimate_cost_microunits(
        std::numeric_limits<std::uint64_t>::max(), 1).has_value());

    // Outcomes are fenced until dispatch has recorded a non-empty attempt;
    // an empty attempt remains invalid even after dispatch.
    RouteRequestPolicy reconcile_policy = real;
    reconcile_policy.idempotency_key = "reconcile-fence";
    reconcile_policy.deadline_ms = 9000;
    const auto reserved = router.decide_and_reserve(reconcile_policy, 4500);
    OMNIA_CHECK(reserved.ok && reserved.grant.has_value());
    OutcomeReport premature{};
    premature.reservation_id = reserved.grant->reservation_id;
    premature.attempt_id = "forged-before-dispatch";
    premature.acceptance = AcceptanceState::Accepted;
    premature.now_ms = 4600;
    const auto premature_outcome = router.reconcile_outcome(premature);
    OMNIA_CHECK(premature_outcome.fenced_late_outcome);
    OMNIA_CHECK(router.reservation(reserved.grant->reservation_id)->status ==
        ReservationStatus::ReservedNotDispatched);
    std::string empty_attempt_error;
    OMNIA_CHECK(!router.mark_dispatched(
        reserved.grant->reservation_id, "", 4600, &empty_attempt_error));
    OMNIA_CHECK(empty_attempt_error == "empty_attempt_id");
    OMNIA_CHECK(router.mark_dispatched(
        reserved.grant->reservation_id, "attempt-reconcile", 4600));
    OutcomeReport empty_outcome = premature;
    empty_outcome.attempt_id.clear();
    empty_outcome.now_ms = 4700;
    OMNIA_CHECK(router.reconcile_outcome(empty_outcome).fenced_late_outcome);
    OutcomeReport accepted = premature;
    accepted.attempt_id = "attempt-reconcile";
    accepted.succeeded = true;
    accepted.usage = ObservedUsage::make_known(10, 5);
    accepted.now_ms = 4800;
    OMNIA_CHECK(!router.reconcile_outcome(accepted).fenced_late_outcome);
}

void test_policy_boundaries_and_reconciliation_overflow() {
    auto has_rejection = [](const DecisionResult& result, const std::string& expected) {
        for (const auto& score : result.receipt.scores) {
            for (const auto& reason : score.rejection_reasons) {
                if (reason == expected) return true;
            }
        }
        return false;
    };

    RouteCandidate baseline{};
    baseline.candidate_id = "boundary-candidate";
    baseline.provider_id = "boundary-provider";
    baseline.model_id = "boundary-model";
    baseline.privacy_tier = PrivacyTier::LocalOnly;
    CandidateResourceState baseline_state{};
    baseline_state.quota = QuotaState::make_known(100000, 0, 999999);

    DynamicProviderRouter boundary_router;
    boundary_router.upsert_candidate(baseline, baseline_state);

    RouteRequestPolicy auth_policy{};
    auth_policy.idempotency_key = "boundary-auth";
    auth_policy.privacy_tier = PrivacyTier::LocalOnly;
    auth_policy.required_auth_boundary = "other-workspace";
    const auto auth = boundary_router.decide_and_reserve(auth_policy, 100);
    OMNIA_CHECK(!auth.ok && has_rejection(auth, "unauthorized_boundary"));

    RouteRequestPolicy provider_policy = auth_policy;
    provider_policy.idempotency_key = "boundary-provider";
    provider_policy.required_auth_boundary = "workspace:default";
    provider_policy.allowed_providers = {"other-provider"};
    const auto provider = boundary_router.decide_and_reserve(provider_policy, 100);
    OMNIA_CHECK(!provider.ok && has_rejection(provider, "provider_not_in_allowed_set"));

    RouteRequestPolicy model_policy = provider_policy;
    model_policy.idempotency_key = "boundary-model";
    model_policy.allowed_providers.clear();
    model_policy.allowed_models = {"other-model"};
    const auto model = boundary_router.decide_and_reserve(model_policy, 100);
    OMNIA_CHECK(!model.ok && has_rejection(model, "model_not_in_allowed_set"));

    RouteRequestPolicy capability_policy = model_policy;
    capability_policy.idempotency_key = "boundary-capability";
    capability_policy.allowed_models.clear();
    capability_policy.required_capabilities.vision = true;
    const auto capability = boundary_router.decide_and_reserve(capability_policy, 100);
    OMNIA_CHECK(!capability.ok && has_rejection(capability, "missing_capability:vision"));

    DynamicProviderRouter retention_router;
    RouteCandidate retained = baseline;
    retained.candidate_id = "retained-candidate";
    retained.model_id = "retained-model";
    retained.retention_hours = 24;
    retention_router.upsert_candidate(retained, baseline_state);
    RouteRequestPolicy retention_policy{};
    retention_policy.idempotency_key = "boundary-retention";
    retention_policy.privacy_tier = PrivacyTier::LocalOnly;
    retention_policy.allowed_models = {"retained-model"};
    retention_policy.max_retention_hours = 1;
    const auto retention = retention_router.decide_and_reserve(retention_policy, 100);
    OMNIA_CHECK(!retention.ok && has_rejection(retention, "retention_exceeded"));

    DynamicProviderRouter deny_router;
    RouteCandidate local = baseline;
    local.candidate_id = "local-parent";
    local.provider_id = "local-provider";
    local.model_id = "local-model";
    RouteCandidate backup = baseline;
    backup.candidate_id = "backup-child";
    backup.provider_id = "backup-provider";
    backup.model_id = "backup-model";
    deny_router.upsert_candidate(local, baseline_state);
    deny_router.upsert_candidate(backup, baseline_state);
    RouteRequestPolicy parent_policy{};
    parent_policy.idempotency_key = "deny-parent";
    parent_policy.privacy_tier = PrivacyTier::LocalOnly;
    parent_policy.allowed_providers = {"local-provider", "backup-provider"};
    parent_policy.allowed_models = {"local-model", "backup-model"};
    parent_policy.forbidden_providers = {"backup-provider"};
    parent_policy.preferred_candidate_ids = {"local-parent"};
    const auto parent = deny_router.decide_and_reserve(parent_policy, 100);
    OMNIA_CHECK(parent.ok && parent.grant.has_value());
    OMNIA_CHECK(parent.grant->candidate_id == "local-parent");
    RouteRequestPolicy fallback_policy = parent_policy;
    fallback_policy.idempotency_key = "deny-child";
    fallback_policy.allowed_providers = {"backup-provider"};
    fallback_policy.allowed_models = {"backup-model"};
    fallback_policy.forbidden_providers.clear();
    const auto denied_fallback = deny_router.decide_fallback(
        parent.grant->reservation_id, fallback_policy, 101);
    OMNIA_CHECK(!denied_fallback.ok);
    OMNIA_CHECK(has_rejection(denied_fallback, "forbidden_provider_or_model"));

    DynamicProviderRouter deadline_router;
    deadline_router.upsert_candidate(baseline, baseline_state);
    RouteRequestPolicy deadline_policy{};
    deadline_policy.idempotency_key = "reconcile-deadline";
    deadline_policy.privacy_tier = PrivacyTier::LocalOnly;
    deadline_policy.deadline_ms = 1000;
    const auto late_reservation = deadline_router.decide_and_reserve(deadline_policy, 100);
    OMNIA_CHECK(late_reservation.ok && late_reservation.grant.has_value());
    OMNIA_CHECK(deadline_router.mark_dispatched(
        late_reservation.grant->reservation_id, "late-attempt", 200));
    OutcomeReport late_report{};
    late_report.reservation_id = late_reservation.grant->reservation_id;
    late_report.attempt_id = "late-attempt";
    late_report.acceptance = AcceptanceState::Accepted;
    late_report.now_ms = 1000;
    const auto late_outcome = deadline_router.reconcile_outcome(late_report);
    OMNIA_CHECK(late_outcome.fenced_late_outcome);
    OMNIA_CHECK(late_outcome.resulting_status == ReservationStatus::OperatorRecoveryRequired);
    OMNIA_CHECK(deadline_router.resolve_operator_recovery(
        late_reservation.grant->reservation_id, false, 1001));

    DynamicProviderRouter usage_router;
    usage_router.upsert_candidate(baseline, baseline_state);
    RouteRequestPolicy usage_policy{};
    usage_policy.idempotency_key = "reconcile-usage-overflow";
    usage_policy.privacy_tier = PrivacyTier::LocalOnly;
    usage_policy.deadline_ms = 10000;
    const auto usage_reservation = usage_router.decide_and_reserve(usage_policy, 100);
    OMNIA_CHECK(usage_reservation.ok && usage_reservation.grant.has_value());
    OMNIA_CHECK(usage_router.mark_dispatched(
        usage_reservation.grant->reservation_id, "overflow-attempt", 200));
    OutcomeReport usage_report{};
    usage_report.reservation_id = usage_reservation.grant->reservation_id;
    usage_report.attempt_id = "overflow-attempt";
    usage_report.acceptance = AcceptanceState::Accepted;
    usage_report.usage = ObservedUsage::make_known(
        std::numeric_limits<std::uint64_t>::max(), 1);
    usage_report.now_ms = 300;
    const auto usage_outcome = usage_router.reconcile_outcome(usage_report);
    OMNIA_CHECK(usage_outcome.resulting_status == ReservationStatus::OperatorRecoveryRequired);
    OMNIA_CHECK(usage_outcome.redacted_note == "usage_overflow");
    OMNIA_CHECK(usage_router.resolve_operator_recovery(
        usage_reservation.grant->reservation_id, false, 301));

    DynamicProviderRouter cost_router;
    CandidateResourceState cost_state = baseline_state;
    cost_state.reconciled_cost_microunits = std::numeric_limits<std::uint64_t>::max();
    cost_router.upsert_candidate(baseline, cost_state);
    RouteRequestPolicy cost_policy = usage_policy;
    cost_policy.idempotency_key = "reconcile-cost-overflow";
    const auto cost_reservation = cost_router.decide_and_reserve(cost_policy, 100);
    OMNIA_CHECK(cost_reservation.ok && cost_reservation.grant.has_value());
    OMNIA_CHECK(cost_router.mark_dispatched(
        cost_reservation.grant->reservation_id, "cost-overflow-attempt", 200));
    OutcomeReport cost_report = usage_report;
    cost_report.reservation_id = cost_reservation.grant->reservation_id;
    cost_report.attempt_id = "cost-overflow-attempt";
    cost_report.usage = ObservedUsage::make_known(1, 1);
    cost_report.actual_cost_microunits = 1;
    cost_report.now_ms = 300;
    const auto cost_outcome = cost_router.reconcile_outcome(cost_report);
    OMNIA_CHECK(cost_outcome.resulting_status == ReservationStatus::OperatorRecoveryRequired);
    OMNIA_CHECK(cost_outcome.redacted_note == "cost_overflow");
    OMNIA_CHECK(cost_router.resolve_operator_recovery(
        cost_reservation.grant->reservation_id, false, 301));
}

} // namespace

int main() {
    test_quota_truth_and_tie_break();
    test_circuit_fencing_and_recovery();
    test_concurrent_reservations();
    test_simulation_and_deadline_fences();
    test_policy_boundaries_and_reconciliation_overflow();
    std::cout << "[PASS] test_omnia_routing (QuotaState, Idempotency, Circuits, Fencing, Restart Recovery)\n";
    return 0;
}
