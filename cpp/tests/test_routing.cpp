#include "test_support.hpp"

#include "omnia/routing/dynamic_router.hpp"

#include <iostream>
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

} // namespace

int main() {
    test_quota_truth_and_tie_break();
    test_circuit_fencing_and_recovery();
    test_concurrent_reservations();
    std::cout << "[PASS] test_omnia_routing (QuotaState, Idempotency, Circuits, Fencing, Restart Recovery)\n";
    return 0;
}
