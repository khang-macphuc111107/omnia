#![forbid(unsafe_code)]

//! Deterministic Zero-Sleep Localhost TCP `ProviderFaultHarness` & SOTA Scheduler Suite
//! (`PF-001..PF-040` / `Shard 07 + 08 + 11`).
//!
//! Uses pure `std::net::{TcpListener, TcpStream}` + `Condvar` stage barriers (zero `sleep()`
//! calls, zero new dependencies) and SHA-256-seeded `SplitMix64` byte fragmentation across
//! multibyte Vietnamese UTF-8 characters, SSE `\r\n\r\n` boundaries, JSON escapes, and
//! `OMNIA_SYNTHETIC_SECRET_CANARY` leak detection.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;

use omnia_core::sha256_hex;
use omnia_routing::{
    classify_post_dispatch_outcome, compute_cache_shape_hash, detect_retired_model_notice,
    normalize_provider_wire_payload, sanitize_input_tool_names, sort_tools_stable, splitmix64_next,
    AcceptanceState, CandidateResourceState, CircuitState, ComboDefinition, ComboProbeOutcome,
    ComboStrategy, DispatchOutcomeClass, DynamicProviderRouter, NotServedDecision, OutcomeReport,
    PostDispatchInput, ProviderWireDialect, QuotaState, ReservationStatus, RouteCandidate,
    RouteRequestPolicy, WireAdapterError, DEFAULT_SOFT_FAIL_WINDOW_MS, MAX_QUOTA_EXHAUSTION_MS,
};
use serde_json::json;

const SYNTHETIC_CANARY: &str = "OMNIA_SYNTHETIC_SECRET_CANARY_DUMMY_01";

/// Deterministic wire fragmentation strategy for HTTP/SSE fault injection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FragmentationPlan {
    /// Splits specifically inside multibyte UTF-8 scalar boundaries, SSE delimiters (`\r\n\r\n`),
    /// JSON escape sequences (`\"`), and tool-call chunks.
    ProtocolBoundaries,
    /// Deterministic PRNG byte chunking seeded via `SplitMix64` from a SHA-256 tag.
    Seeded { seed: u64, min_chunk: usize, max_chunk: usize },
}

impl FragmentationPlan {
    fn seed_from_label(label: &str) -> u64 {
        let hex = sha256_hex(label.as_bytes());
        u64::from_str_radix(&hex[..16], 16).unwrap_or(0x5eed_cafe_1234_5678)
    }

    fn plan_chunks(self, payload: &[u8]) -> Vec<Vec<u8>> {
        if payload.is_empty() {
            return Vec::new();
        }
        match self {
            Self::ProtocolBoundaries => {
                // Force deliberate single-byte / 1-2B splits around non-ASCII (>= 0x80), '\r', '\n', and '\\'.
                let mut cuts = Vec::new();
                let mut i = 0;
                while i < payload.len() {
                    let b = payload[i];
                    let step = if b >= 0x80 || matches!(b, b'\r' | b'\n' | b'\\') {
                        1
                    } else {
                        ((i % 3) + 1).min(payload.len() - i)
                    };
                    let end = (i + step).min(payload.len());
                    cuts.push(payload[i..end].to_vec());
                    i = end;
                }
                cuts
            }
            Self::Seeded {
                mut seed,
                min_chunk,
                max_chunk,
            } => {
                let lo = min_chunk.max(1);
                let hi = max_chunk.max(lo);
                let span = (hi - lo + 1) as u64;
                let mut out = Vec::new();
                let mut i = 0;
                while i < payload.len() {
                    seed = splitmix64_next(seed);
                    let len = lo + ((seed % span) as usize);
                    let end = (i + len).min(payload.len());
                    out.push(payload[i..end].to_vec());
                    i = end;
                }
                out
            }
        }
    }
}

/// Zero-sleep blocking checkpoint synchronization gate between mock server and client test.
#[derive(Debug, Default)]
struct StageGate {
    state: Mutex<(Vec<String>, Vec<String>)>, // (reached_stages, released_stages)
    cv: Condvar,
}

impl StageGate {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn mark_reached(&self, stage: &str) {
        let mut g = self.state.lock().expect("stage lock");
        g.0.push(stage.to_owned());
        self.cv.notify_all();
    }

    fn await_reached(&self, stage: &str) {
        let mut g = self.state.lock().expect("stage lock");
        while !g.0.iter().any(|s| s == stage) {
            g = self.cv.wait(g).expect("stage wait");
        }
    }

    fn release(&self, stage: &str) {
        let mut g = self.state.lock().expect("stage lock");
        g.1.push(stage.to_owned());
        self.cv.notify_all();
    }

    fn await_released(&self, stage: &str) {
        let mut g = self.state.lock().expect("stage lock");
        while !g.1.iter().any(|s| s == stage) {
            g = self.cv.wait(g).expect("stage wait");
        }
    }
}

enum FaultBehavior {
    /// Writes HTTP 200 SSE headers + fragmented Vietnamese payload, pauses at `barrier_stage`,
    /// then drops connection cleanly via `Shutdown::Write` without `[DONE]` (`OutcomeUnknown`).
    DropAfterPartialSse {
        plan: FragmentationPlan,
        sse_body: Vec<u8>,
        barrier_stage: String,
    },
    /// Writes fragmented complete SSE stream including terminal `[DONE]` (`Accepted`).
    CompleteSse {
        plan: FragmentationPlan,
        sse_body: Vec<u8>,
    },
    /// Writes HTTP error injecting `SYNTHETIC_CANARY` in error body (`NotAccepted`).
    RejectWithCanary {
        status: u16,
        body: String,
    },
}

fn spawn_fault_server(behavior: FaultBehavior, gate: Arc<StageGate>) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let addr = listener.local_addr().expect("local addr").to_string();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept client");
        let mut req_buf = [0u8; 2048];
        let _ = stream.read(&mut req_buf);

        match behavior {
            FaultBehavior::DropAfterPartialSse {
                plan,
                sse_body,
                barrier_stage,
            } => {
                let hdr = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
                stream.write_all(hdr).expect("write hdr");
                let _ = stream.flush();
                for chunk in plan.plan_chunks(&sse_body) {
                    stream.write_all(&chunk).expect("write partial sse chunk");
                    let _ = stream.flush();
                }
                gate.mark_reached(&barrier_stage);
                gate.await_released(&barrier_stage);
                let _ = stream.shutdown(Shutdown::Write);
            }
            FaultBehavior::CompleteSse { plan, sse_body } => {
                let hdr = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
                stream.write_all(hdr).expect("write hdr");
                for chunk in plan.plan_chunks(&sse_body) {
                    stream.write_all(&chunk).expect("write sse chunk");
                }
                let _ = stream.flush();
                let _ = stream.shutdown(Shutdown::Write);
            }
            FaultBehavior::RejectWithCanary { status, body } => {
                let resp = format!(
                    "HTTP/1.1 {status} Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(resp.as_bytes()).expect("write reject");
                let _ = stream.flush();
                let _ = stream.shutdown(Shutdown::Write);
            }
        }
    });
    (addr, handle)
}

fn read_http_stream_frames(addr: &str) -> (Option<u16>, Vec<u8>, bool) {
    let mut stream = TcpStream::connect(addr).expect("connect fault server");
    stream
        .write_all(b"POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}")
        .expect("send request");
    let _ = stream.flush();
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let split_pos = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|idx| idx + 4);
    let (hdr_bytes, body_bytes) = match split_pos {
        Some(pos) => (&raw[..pos], &raw[pos..]),
        None => (&raw[..], &[][..]),
    };
    let hdr_str = String::from_utf8_lossy(hdr_bytes);
    let status = hdr_str
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok());
    let body_str = String::from_utf8_lossy(body_bytes);
    let terminal = body_str.contains("[DONE]")
        || body_str.contains("response.completed")
        || body_str.contains("message_stop");
    (status, body_bytes.to_vec(), terminal)
}

fn make_candidate(id: &str, provider: &str, model: &str, prio: i32) -> RouteCandidate {
    RouteCandidate {
        candidate_id: id.to_owned(),
        provider_id: provider.to_owned(),
        model_id: model.to_owned(),
        route_priority: prio,
        ..RouteCandidate::default()
    }
}

#[test]
fn fault_harness_utf8_protocol_boundaries_and_outcome_unknown_blocks_double_billing() {
    let gate = StageGate::new();
    let sse_text = concat!(
        "data: {\"delta\":\"Xin chào tiếng Việt — kiểm thử cắt UTF-8 ",
        "\\n\\\"escaped\\\"\"}\r\n\r\n"
    );
    let (addr, server) = spawn_fault_server(
        FaultBehavior::DropAfterPartialSse {
            plan: FragmentationPlan::ProtocolBoundaries,
            sse_body: sse_text.as_bytes().to_vec(),
            barrier_stage: "partial_written".to_owned(),
        },
        Arc::clone(&gate),
    );

    let reader = thread::spawn(move || read_http_stream_frames(&addr));
    gate.await_reached("partial_written");
    gate.release("partial_written");

    let (status, body, terminal) = reader.join().expect("reader join");
    server.join().expect("server join");

    assert_eq!(status, Some(200));
    assert!(!terminal);
    // Multibyte Vietnamese UTF-8 reassembles losslessly across 1-byte wire splits!
    let reassembled = String::from_utf8(body).expect("lossless utf8 across 1B splits");
    assert!(reassembled.contains("Xin chào tiếng Việt"));

    let router = DynamicProviderRouter::new();
    let now_ms = 1_760_000_000_000i64;
    router
        .upsert_candidate(
            make_candidate("p1::gpt", "p1", "gpt-5.4", 10),
            CandidateResourceState {
                quota: QuotaState::known(100_000, 100),
                ..Default::default()
            },
        )
        .unwrap();
    let dec = router
        .decide_and_reserve(&RouteRequestPolicy {
            request_id: "req-fault-1".into(),
            idempotency_key: "idem-fault-1".into(),
            estimated_input_tokens: 1_000,
            estimated_output_tokens: 500,
            now_epoch_ms: Some(now_ms),
            ..Default::default()
        })
        .unwrap();
    let grant = dec.reservation.unwrap();
    router
        .mark_dispatched_with_attempt(&grant.reservation_id, grant.fencing_token, "att-1", now_ms)
        .unwrap();

    let (class, receipt) = router
        .reconcile_post_dispatch(
            &grant.reservation_id,
            grant.fencing_token,
            "att-1",
            &PostDispatchInput {
                http_status: status,
                bytes_received: reassembled.len(),
                upstream_accepted: true,
                terminal_received: terminal,
                stream_dropped: !terminal,
                ..Default::default()
            },
            Some(25.0),
            false,
            now_ms + 10,
        )
        .unwrap();

    assert_eq!(class.outcome_class, DispatchOutcomeClass::Unknown);
    assert_eq!(class.acceptance_state, AcceptanceState::Unknown);
    assert!(class.blocks_auto_retry);
    assert_eq!(receipt.status, ReservationStatus::OperatorRecoveryRequired);

    // Automatic fallback MUST be refused while outcome is Unknown (prevents double-billing).
    let fb = router
        .decide_fallback(
            &grant.reservation_id,
            &RouteRequestPolicy {
                request_id: "req-fault-fb".into(),
                idempotency_key: "idem-fault-fb".into(),
                now_epoch_ms: Some(now_ms + 20),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(!fb.allowed);
}

#[test]
fn fault_harness_seeded_splitmix64_complete_sse_and_canary_secret_redaction() {
    let seed = FragmentationPlan::seed_from_label("PF-002-complete-sse-vn");
    let seed2 = FragmentationPlan::seed_from_label("PF-002-complete-sse-vn");
    assert_eq!(seed, seed2);

    let full_sse = b"event: message\r\ndata: {\"delta\":\"Ho\xc3\xa0n t\xe1\xba\xa5t ti\xe1\xba\xbfng Vi\xe1\xbb\x87t\"}\r\n\r\ndata: [DONE]\r\n\r\n";
    let p1 = FragmentationPlan::Seeded {
        seed,
        min_chunk: 1,
        max_chunk: 4,
    };
    assert_eq!(p1.plan_chunks(full_sse), p1.plan_chunks(full_sse));

    let gate = StageGate::new();
    let (addr_ok, srv_ok) = spawn_fault_server(
        FaultBehavior::CompleteSse {
            plan: p1,
            sse_body: full_sse.to_vec(),
        },
        Arc::clone(&gate),
    );
    let (st_ok, body_ok, term_ok) = read_http_stream_frames(&addr_ok);
    srv_ok.join().unwrap();
    assert_eq!(st_ok, Some(200));
    assert!(term_ok);
    assert!(String::from_utf8(body_ok).unwrap().contains("Hoàn tất tiếng Việt"));

    // Reject path carrying a canary bearer token in raw upstream payload -> MUST be redacted across
    // receipts, failover timeline, and SQLite persistence.
    let (addr_err, srv_err) = spawn_fault_server(
        FaultBehavior::RejectWithCanary {
            status: 502,
            body: format!(r#"{{"error":"upstream fail Authorization: Bearer {SYNTHETIC_CANARY}"}}"#),
        },
        StageGate::new(),
    );
    let (st_err, body_err, term_err) = read_http_stream_frames(&addr_err);
    srv_err.join().unwrap();
    assert_eq!(st_err, Some(502));
    assert!(!term_err);
    let err_txt = String::from_utf8_lossy(&body_err).to_string();

    let tmp_db = std::env::temp_dir().join(format!("omnia_pf_canary_{seed:016x}.db"));
    let _ = std::fs::remove_file(&tmp_db);
    let now_ms = 1_760_000_000_000i64;
    let router = DynamicProviderRouter::open_sqlite(&tmp_db, now_ms).unwrap();
    router
        .upsert_candidate(
            make_candidate("acct-canary", "proxy", "gpt-5.4", 10),
            CandidateResourceState {
                quota: QuotaState::known(100_000, 100),
                ..Default::default()
            },
        )
        .unwrap();

    let dec = router
        .decide_and_reserve(&RouteRequestPolicy {
            request_id: "req-canary".into(),
            idempotency_key: "idem-canary".into(),
            now_epoch_ms: Some(now_ms),
            ..Default::default()
        })
        .unwrap();
    let g = dec.reservation.unwrap();
    router
        .mark_dispatched_with_attempt(&g.reservation_id, g.fencing_token, "att-c", now_ms)
        .unwrap();
    let cls = classify_post_dispatch_outcome(&PostDispatchInput {
        http_status: st_err,
        bytes_received: body_err.len(),
        ..Default::default()
    });
    assert_eq!(cls.outcome_class, DispatchOutcomeClass::NotAccepted);

    let receipt = router
        .reconcile_in_flight_outcome(OutcomeReport {
            reservation_id: g.reservation_id,
            fencing_token: g.fencing_token,
            attempt_id: Some("att-c".into()),
            success: false,
            acceptance: cls.acceptance_state,
            diagnostic_note: err_txt.clone(),
            soft_fail: true,
            now_epoch_ms: Some(now_ms + 5),
            ..Default::default()
        })
        .unwrap();
    assert!(!receipt.diagnostic_note.contains(SYNTHETIC_CANARY));
    let _ = router.record_soft_fail("acct-canary", None, now_ms + 10, &err_txt);
    for ev in router.failover_timeline(20).unwrap() {
        assert!(!ev.reason.contains(SYNTHETIC_CANARY));
    }
    drop(router);
    let _ = std::fs::remove_file(&tmp_db);
}

#[test]
fn sota_scheduler_soft_fail_non_outage_and_stated_quota_reset_and_preserving_upsert() {
    let tmp_db = std::env::temp_dir().join("omnia_sota_router_persist.db");
    let _ = std::fs::remove_file(&tmp_db);
    let now_ms = 1_760_000_000_000i64;

    {
        let router = DynamicProviderRouter::open_sqlite(&tmp_db, now_ms).unwrap();
        router
            .upsert_candidate(
                make_candidate("acct-1", "openai", "gpt-5.4", 20),
                CandidateResourceState {
                    quota: QuotaState::known(100_000, 100),
                    ..Default::default()
                },
            )
            .unwrap();
        router
            .upsert_candidate(
                make_candidate("acct-2", "openai", "gpt-5.4", 10),
                CandidateResourceState {
                    quota: QuotaState::known(100_000, 100),
                    ..Default::default()
                },
            )
            .unwrap();

        // 5s softFail demotes acct-1 below acct-2 WITHOUT opening acct-1's circuit!
        router
            .record_soft_fail("acct-1", None, now_ms, "transient 502")
            .unwrap();
        let d1 = router
            .decide_and_reserve(&RouteRequestPolicy {
                request_id: "r-soft-1".into(),
                idempotency_key: "i-soft-1".into(),
                now_epoch_ms: Some(now_ms + 100),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            d1.receipt.selected_candidate_id.as_deref(),
            Some("acct-2")
        );

        // If sibling acct-2 is ALSO soft-failed (or single-account pool), softFail still avoids 503!
        router
            .record_soft_fail("acct-2", None, now_ms + 200, "transient 429")
            .unwrap();
        let d2 = router
            .decide_and_reserve(&RouteRequestPolicy {
                request_id: "r-soft-2".into(),
                idempotency_key: "i-soft-2".into(),
                now_epoch_ms: Some(now_ms + 300),
                ..Default::default()
            })
            .unwrap();
        assert!(d2.allowed, "all-soft-fail pool must NOT cause 503 outage");

        // After 5,000ms window expires, acct-1 recovers cleanly with CircuitState::Closed.
        let sim_after = router
            .simulate_route(&RouteRequestPolicy {
                request_id: "r-soft-3".into(),
                now_epoch_ms: Some(now_ms + DEFAULT_SOFT_FAIL_WINDOW_MS + 1),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            sim_after.receipt.selected_candidate_id.as_deref(),
            Some("acct-1")
        );

        // Provider-stated QuotaResetAt monotonic (never shortened) and capped at 7d, surfaces 429 status.
        let reset_far = now_ms + 60_000;
        let reset_near = now_ms + 10_000;
        assert_eq!(
            router
                .record_provider_quota_reset("acct-1", reset_far, now_ms, "resets_at")
                .unwrap(),
            reset_far
        );
        assert_eq!(
            router
                .record_provider_quota_reset("acct-1", reset_near, now_ms, "must_not_shorten")
                .unwrap(),
            reset_far
        );
        let too_far = router
            .record_provider_quota_reset("acct-2", now_ms + MAX_QUOTA_EXHAUSTION_MS + 99_999, now_ms, "cap_7d")
            .unwrap();
        assert_eq!(too_far, now_ms + MAX_QUOTA_EXHAUSTION_MS);

        let pool_status = router
            .pool_quota_reset_status(Some("openai"), now_ms + 1_000)
            .unwrap()
            .expect("entire pool awaiting stated reset");
        assert_eq!(pool_status.error_code, "usage_limit_reached");
        assert_eq!(pool_status.reset_at_ms, reset_far);
        assert_eq!(pool_status.resets_in_seconds, 59);
    }

    // Reopen SQLite and verify upsert_candidate_preserving_state keeps persisted state intact!
    {
        let reopened = DynamicProviderRouter::open_sqlite(&tmp_db, now_ms + 2_000).unwrap();
        reopened
            .upsert_candidate_preserving_state(
                make_candidate("acct-1", "openai", "gpt-5.4", 25),
                CandidateResourceState::default(),
            )
            .unwrap();
        let snap = reopened
            .snapshots(now_ms + 2_000)
            .unwrap()
            .into_iter()
            .find(|s| s.candidate.candidate_id == "acct-1")
            .unwrap();
        assert_eq!(snap.candidate.route_priority, 25);
        assert!(snap.state.provider_quota_reset_until_ms.is_some());
        assert_eq!(snap.state.circuit, CircuitState::Closed);
    }
    let _ = std::fs::remove_file(&tmp_db);
}

#[test]
fn sota_combo_not_served_retired_and_wire_adapter_end_to_end() {
    let router = DynamicProviderRouter::new();
    router
        .upsert_combo(ComboDefinition {
            id: "coding-primary".into(),
            strategy: ComboStrategy::Fallback,
            members: vec!["gpt-5.4".into(), "combo/tier2".into()],
        })
        .unwrap();
    router
        .upsert_combo(ComboDefinition {
            id: "tier2".into(),
            strategy: ComboStrategy::Fallback,
            members: vec!["claude-sonnet-4-6".into()],
        })
        .unwrap();
    router
        .record_combo_member_failure("combo/coding-primary", "gpt-5.4", 1_000)
        .unwrap();
    let res = router.resolve_combo("combo/coding-primary", 1_500).unwrap();
    assert_eq!(
        res.ordered_targets(),
        vec!["claude-sonnet-4-6", "gpt-5.4"]
    );
    let due = router.claim_due_combo_probes(31_000).unwrap();
    assert_eq!(due.len(), 1);
    router
        .complete_combo_probe("coding-primary", "gpt-5.4", ComboProbeOutcome::Healthy, 31_100)
        .unwrap();
    assert_eq!(
        router.peek_combo("coding-primary").unwrap().active_members,
        vec!["gpt-5.4", "claude-sonnet-4-6"]
    );

    assert_eq!(
        router
            .record_not_served_outcome("pool", "missing-m", "c1", 1)
            .unwrap(),
        NotServedDecision::ModelNotFound404 {
            error_code: "model_not_found".into(),
            model_id: "missing-m".into(),
            failed_candidates: 1,
        }
    );
    assert!(detect_retired_model_notice(
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"gemini-1.5-pro is no longer available. Please switch to gemini-2.5-pro.\"}]}}]}\n\n"
    )
    .is_some());

    let mut payload = json!({
        "model": "claude-sonnet-4-6",
        "max_tokens": 4096,
        "tools": [
            { "name": "z_tool", "cache_control": { "type": "ephemeral", "ttl": "1h" } },
            { "name": "a_tool" }
        ],
        "messages": [
            { "role": "user", "name": "bad/tool name", "content": "hi" }
        ]
    });
    sort_tools_stable(&mut payload);
    sanitize_input_tool_names(&mut payload);
    let digest = compute_cache_shape_hash(&payload);
    assert_eq!(payload["tools"][0]["name"], "a_tool");
    assert_eq!(digest.prefix_8hex.len(), 8);
    assert!(normalize_provider_wire_payload(ProviderWireDialect::AnthropicMessages, &payload).is_ok());
    assert!(matches!(
        normalize_provider_wire_payload(
            ProviderWireDialect::AnthropicMessages,
            &json!({
                "model": "claude-sonnet-4-6",
                "max_tokens": 4096,
                "tools": [{ "name": "t", "cache_control": { "type": "ephemeral", "ttl": "5m" } }],
                "messages": [{ "role": "user", "content": [{ "type": "text", "text": "x", "cache_control": { "type": "ephemeral", "ttl": "1h" } }] }]
            })
        ),
        Err(WireAdapterError::AnthropicInvalidCacheTtlOrder { .. })
    ));
}
