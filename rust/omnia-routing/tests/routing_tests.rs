use std::sync::Arc;
use std::thread;

use omnia_routing::{
    AcceptanceState, CandidateResourceState, CircuitState, DynamicProviderRouter,
    EmergencyQuotaMode, EmergencyQuotaPolicy, FallbackScope, OutcomeReport, PrivacyTier,
    QuotaState, ReservationStatus, RouteCandidate, RouteRequestPolicy, RoutingError,
};

fn base_candidate(id: &str, provider: &str, model: &str) -> RouteCandidate {
    RouteCandidate {
        candidate_id: id.to_owned(),
        provider_id: provider.to_owned(),
        model_id: model.to_owned(),
        ..RouteCandidate::default()
    }
}

fn known_state(tokens: i64, requests: i64) -> CandidateResourceState {
    CandidateResourceState {
        quota: QuotaState::known(tokens, requests),
        ..CandidateResourceState::default()
    }
}

#[test]
fn quota_truth_and_tie_break() {
    let router = DynamicProviderRouter::new();

    router
        .upsert_candidate(
            base_candidate("cand-unknown", "anthropic", "claude-sonnet"),
            CandidateResourceState {
                quota: QuotaState::unknown("missing provider headers"),
                ..CandidateResourceState::default()
            },
        )
        .expect("upsert unknown");

    router
        .upsert_candidate(
            base_candidate("cand-stale", "openai", "gpt-5"),
            CandidateResourceState {
                quota: QuotaState::stale(500_000, 100, "expired telemetry"),
                ..CandidateResourceState::default()
            },
        )
        .expect("upsert stale");

    router
        .upsert_candidate(
            base_candidate("cand-contradictory", "google", "gemini-pro"),
            CandidateResourceState {
                quota: QuotaState::contradictory("remaining < 0 while ok=true"),
                ..CandidateResourceState::default()
            },
        )
        .expect("upsert contradictory");

    let mut base_policy = RouteRequestPolicy {
        request_id: "req-deny-truth".to_owned(),
        idempotency_key: "idem-deny-truth".to_owned(),
        estimated_input_tokens: 1_000,
        estimated_output_tokens: 500,
        now_epoch_ms: Some(1_000),
        ..RouteRequestPolicy::default()
    };
    assert_eq!(base_policy.token_budget, None);

    let denied = router
        .decide_and_reserve(&base_policy)
        .expect("decide denied");
    assert!(!denied.allowed);
    assert!(denied.reservation.is_none());
    assert_eq!(denied.receipt.token_budget, None);

    // Emergency reserve can rescue Unknown quota, never Contradictory quota.
    let mut emergency_policy = base_policy.clone();
    emergency_policy.request_id = "req-emergency".to_owned();
    emergency_policy.idempotency_key = "idem-emergency".to_owned();
    emergency_policy.emergency_policy = EmergencyQuotaPolicy {
        mode: EmergencyQuotaMode::AllowEmergencyReserve,
        emergency_reserve_tokens: 10_000,
        stale_fallback_cap_tokens: 0,
        allow_on_critical_risk: false,
    };
    let rescued = router
        .decide_and_reserve(&emergency_policy)
        .expect("decide emergency");
    assert!(rescued.allowed);
    assert_eq!(
        rescued.receipt.selected_candidate_id.as_deref(),
        Some("cand-unknown")
    );

    // Register two identical known-quota candidates to verify deterministic tie-break on candidate_id.
    router
        .upsert_candidate(
            base_candidate("cand-beta", "anthropic", "claude-sonnet"),
            known_state(2_000_000, 200),
        )
        .expect("upsert beta");
    router
        .upsert_candidate(
            base_candidate("cand-alpha", "anthropic", "claude-sonnet"),
            known_state(2_000_000, 200),
        )
        .expect("upsert alpha");

    base_policy.request_id = "req-tie".to_owned();
    base_policy.idempotency_key = "idem-tie".to_owned();
    let tie = router.decide_and_reserve(&base_policy).expect("decide tie");
    assert!(tie.allowed);
    assert_eq!(
        tie.receipt.selected_candidate_id.as_deref(),
        Some("cand-alpha")
    );

    // Idempotent replay with same key must return the exact same reservation and avoid double-reserving.
    let replay = router
        .decide_and_reserve(&base_policy)
        .expect("replay idempotent");
    assert_eq!(
        replay.reservation.as_ref().map(|r| &r.reservation_id),
        tie.reservation.as_ref().map(|r| &r.reservation_id)
    );
}

#[test]
fn circuit_fencing_and_recovery() {
    let router = DynamicProviderRouter::with_circuit_config(2, 5_000);
    router
        .upsert_candidate(
            base_candidate("cand-primary", "openai", "gpt-5"),
            known_state(500_000, 50),
        )
        .expect("upsert primary");

    let mut secondary = base_candidate("cand-backup", "anthropic", "claude-sonnet");
    secondary.route_priority = -20;
    router
        .upsert_candidate(secondary, known_state(500_000, 50))
        .expect("upsert backup");

    let mut policy = RouteRequestPolicy {
        request_id: "req-c1".to_owned(),
        idempotency_key: "idem-c1".to_owned(),
        now_epoch_ms: Some(1_000),
        ..RouteRequestPolicy::default()
    };

    // Failure #1
    let d1 = router.decide_and_reserve(&policy).expect("d1");
    let r1 = d1.reservation.expect("r1");
    assert_eq!(r1.candidate_id, "cand-primary");
    router
        .mark_dispatched(&r1.reservation_id, r1.fencing_token)
        .expect("dispatch r1");

    // Stale fencing token rejection
    let stale_err = router
        .reconcile_outcome(OutcomeReport {
            reservation_id: r1.reservation_id.clone(),
            fencing_token: r1.fencing_token + 99,
            success: true,
            acceptance: AcceptanceState::Accepted,
            now_epoch_ms: Some(1_050),
            ..OutcomeReport::default()
        })
        .expect_err("stale fencing token must fail");
    assert!(matches!(stale_err, RoutingError::StaleFencingToken { .. }));

    router
        .reconcile_outcome(OutcomeReport {
            reservation_id: r1.reservation_id.clone(),
            fencing_token: r1.fencing_token,
            success: false,
            acceptance: AcceptanceState::NotSent,
            latency_ms: Some(120.0),
            diagnostic_note: "timeout sk-ant-secret1234567890abcdef".to_owned(),
            now_epoch_ms: Some(1_100),
            ..OutcomeReport::default()
        })
        .expect("reconcile failure 1");

    // Verify receipt diagnostic is redacted
    let receipts = router.outcome_receipts().expect("outcome receipts");
    assert!(!receipts[0]
        .diagnostic_note
        .contains("secret1234567890abcdef"));
    let receipt_json = receipts[0].to_json().to_string();
    assert!(!receipt_json.contains("sk-ant-"));

    // Failure #2 trips circuit Open
    policy.request_id = "req-c2".to_owned();
    policy.idempotency_key = "idem-c2".to_owned();
    policy.now_epoch_ms = Some(1_200);
    let d2 = router.decide_and_reserve(&policy).expect("d2");
    let r2 = d2.reservation.expect("r2");
    assert_eq!(r2.candidate_id, "cand-primary");
    router
        .reconcile_outcome(OutcomeReport {
            reservation_id: r2.reservation_id,
            fencing_token: r2.fencing_token,
            success: false,
            acceptance: AcceptanceState::NotSent,
            now_epoch_ms: Some(1_250),
            ..OutcomeReport::default()
        })
        .expect("reconcile failure 2");

    // Now cand-primary is Open; route must select cand-backup.
    policy.request_id = "req-c3".to_owned();
    policy.idempotency_key = "idem-c3".to_owned();
    policy.now_epoch_ms = Some(1_300);
    let d3 = router.decide_and_reserve(&policy).expect("d3");
    assert!(d3.allowed);
    assert_eq!(
        d3.receipt.selected_candidate_id.as_deref(),
        Some("cand-backup")
    );
    let r3 = d3.reservation.expect("r3");
    router
        .mark_dispatched(&r3.reservation_id, r3.fencing_token)
        .expect("dispatch r3");

    // Crash/restart before r3 completes -> OrphanedOnRestart, reservations released
    let recovered = router.recover_after_restart(2_000).expect("recover");
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].status, ReservationStatus::OrphanedOnRestart);

    // Fallback must be blocked for OrphanedOnRestart
    let blocked_fb = router
        .decide_fallback(&r3.reservation_id, &policy)
        .expect("fallback on orphan");
    assert!(!blocked_fb.allowed);

    // Operator resolves recovery safely
    let op_receipt = router
        .resolve_operator_recovery(
            &r3.reservation_id,
            false,
            None,
            "verified aborted upstream",
            2_100,
        )
        .expect("resolve operator recovery");
    assert_eq!(op_receipt.status, ReservationStatus::ReconciledReleased);

    // Advance past 5000ms cooldown -> cand-primary becomes HalfOpen, allows one probe, closes on success
    let snaps = router.snapshots(7_000).expect("snapshots");
    let primary_snap = snaps
        .iter()
        .find(|s| s.candidate.candidate_id == "cand-primary")
        .expect("primary snap");
    assert!(matches!(
        primary_snap.state.circuit,
        CircuitState::HalfOpen {
            probe_in_flight: false
        }
    ));

    policy.request_id = "req-c4-probe".to_owned();
    policy.idempotency_key = "idem-c4-probe".to_owned();
    policy.now_epoch_ms = Some(7_010);
    let d4 = router.decide_and_reserve(&policy).expect("d4 probe");
    let r4 = d4.reservation.expect("r4 probe");
    assert_eq!(r4.candidate_id, "cand-primary");

    // While probe_in_flight is true, a concurrent request must route to cand-backup
    policy.request_id = "req-c5-concurrent".to_owned();
    policy.idempotency_key = "idem-c5-concurrent".to_owned();
    policy.now_epoch_ms = Some(7_020);
    let d5 = router.decide_and_reserve(&policy).expect("d5 concurrent");
    assert_eq!(
        d5.receipt.selected_candidate_id.as_deref(),
        Some("cand-backup")
    );

    // Succeeding probe closes circuit
    router
        .reconcile_outcome(OutcomeReport {
            reservation_id: r4.reservation_id,
            fencing_token: r4.fencing_token,
            success: true,
            acceptance: AcceptanceState::Accepted,
            latency_ms: Some(90.0),
            now_epoch_ms: Some(7_100),
            ..OutcomeReport::default()
        })
        .expect("reconcile probe");

    let snaps_after = router.snapshots(7_150).expect("snapshots after");
    let primary_after = snaps_after
        .iter()
        .find(|s| s.candidate.candidate_id == "cand-primary")
        .expect("primary after");
    assert_eq!(primary_after.state.circuit, CircuitState::Closed);
}

#[test]
fn concurrent_reservations() {
    let router = Arc::new(DynamicProviderRouter::new());
    router
        .upsert_candidate(
            base_candidate("cand-conc", "openai", "gpt-5"),
            known_state(1_000_000, 10),
        )
        .expect("upsert conc");

    let mut handles = Vec::new();
    for t in 0..4usize {
        let router_cloned = Arc::clone(&router);
        handles.push(thread::spawn(move || {
            let mut wins = 0usize;
            for i in 0..5usize {
                let policy = RouteRequestPolicy {
                    request_id: format!("req-t{t}-{i}"),
                    idempotency_key: format!("idem-t{t}-{i}"),
                    estimated_input_tokens: 1_000,
                    estimated_output_tokens: 500,
                    now_epoch_ms: Some(10_000),
                    ..RouteRequestPolicy::default()
                };
                let res = router_cloned.decide_and_reserve(&policy).expect("decide");
                if res.allowed {
                    wins += 1;
                }
            }
            wins
        }));
    }

    let total_wins: usize = handles.into_iter().map(|h| h.join().expect("join")).sum();
    assert_eq!(total_wins, 10);

    let snaps = router.snapshots(10_100).expect("snaps");
    assert_eq!(snaps[0].state.reserved_requests, 10);
    assert_eq!(snaps[0].state.reserved_tokens, 15_000);
}

#[test]
fn fallback_privacy_and_window_rollover() {
    let router = DynamicProviderRouter::new();
    let mut local_primary = base_candidate("local-a", "ollama", "qwen-local");
    local_primary.privacy_tier = PrivacyTier::LocalOnly;
    let mut public_alt = base_candidate("pub-b", "openai", "gpt-5");
    public_alt.privacy_tier = PrivacyTier::Public;
    let mut local_alt = base_candidate("local-b", "vllm", "llama-local");
    local_alt.privacy_tier = PrivacyTier::LocalOnly;
    local_alt.route_priority = -20;

    let window_quota =
        QuotaState::known_with_window(5_000, 2, 100_000, 60_000, Some(5_000), Some(1_000), 120_000);
    router
        .upsert_candidate(
            local_primary,
            CandidateResourceState {
                quota: window_quota,
                ..CandidateResourceState::default()
            },
        )
        .expect("upsert local-a");
    router
        .upsert_candidate(public_alt, known_state(500_000, 100))
        .expect("upsert pub-b");
    router
        .upsert_candidate(local_alt, known_state(500_000, 100))
        .expect("upsert local-b");

    let policy = RouteRequestPolicy {
        request_id: "req-fb".to_owned(),
        idempotency_key: "idem-fb".to_owned(),
        minimum_privacy_tier: PrivacyTier::LocalOnly,
        fallback_scope: FallbackScope::SamePrivacyBoundary,
        now_epoch_ms: Some(1_500),
        ..RouteRequestPolicy::default()
    };
    let d1 = router.decide_and_reserve(&policy).expect("d1");
    let r1 = d1.reservation.expect("r1");
    assert_eq!(r1.candidate_id, "local-a");
    router
        .reconcile_outcome(OutcomeReport {
            reservation_id: r1.reservation_id.clone(),
            fencing_token: r1.fencing_token,
            success: false,
            acceptance: AcceptanceState::NotSent,
            now_epoch_ms: Some(1_600),
            ..OutcomeReport::default()
        })
        .expect("reconcile fail");

    let fb = router
        .decide_fallback(&r1.reservation_id, &policy)
        .expect("fallback");
    assert!(fb.allowed);
    assert_eq!(fb.receipt.selected_candidate_id.as_deref(), Some("local-b"));

    // Window rollover at t = 6_000 refreshes local-a capacity back to 100_000.
    let snaps = router.snapshots(6_000).expect("rollover snapshots");
    let local_a = snaps
        .iter()
        .find(|s| s.candidate.candidate_id == "local-a")
        .expect("local-a snap");
    assert!(matches!(
        local_a.state.quota,
        QuotaState::Known {
            remaining_tokens: 100_000,
            ..
        }
    ));
}
