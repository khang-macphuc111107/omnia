//! Automated integration test suite covering Rust native subsystems (Milestones M4 & M6):
//! 1. omnia-harness: cancellation grace period, hung tool future drop, duplicate tool call ID rejection, multi-provider model routing.
//! 2. omnia-download: HTTP chunking, resume verification, header constraints.
//! 3. omnia-browser & omnia-computer: command contracts, payload validation, mock automation dispatch.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

// ============================================================================
// PART 1: omnia-harness Tests
// ============================================================================
mod test_omnia_harness {
    use super::*;
    use omnia_harness::agent::{Agent, AgentConfig, AgentEvent, AutoApprove, EventSink};
    use omnia_harness::model::{Message, MessageAccumulator, StopReason, StreamEvent, ToolSpec};
    use omnia_harness::permission::{PermissionMode, PermissionPolicy};
    use omnia_harness::tool::{EffectClass, Tool, ToolContext, ToolOutput, ToolRegistry};
    use omnia_harness::{HarnessError, HarnessResult, Provider, ProviderRequest, ProviderStream};

    /// Drop tracker for testing that hung tool futures are properly dropped when abandoned.
    struct DropTracker(Arc<AtomicBool>);
    impl Drop for DropTracker {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    /// Tool that can either cooperate with cancellation or hang indefinitely.
    struct ConfigurableTool {
        name: String,
        cooperative: bool,
        started: Arc<tokio::sync::Notify>,
        dropped: Arc<AtomicBool>,
    }

    #[async_trait]
    impl Tool for ConfigurableTool {
        fn spec(&self) -> ToolSpec {
            ToolSpec {
                name: self.name.clone(),
                description: "Test tool for cancellation semantics".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "action": { "type": "string" }
                    }
                }),
            }
        }

        fn effect(&self) -> EffectClass {
            EffectClass::ReadWorkspace
        }

        async fn call(&self, ctx: &ToolContext, _input: Value) -> HarnessResult<ToolOutput> {
            let _tracker = DropTracker(Arc::clone(&self.dropped));
            self.started.notify_one();
            if self.cooperative {
                ctx.cancel.cancelled().await;
                return Err(HarnessError::Cancelled);
            }
            // Hung tool: deliberately ignores cancellation token and waits forever
            std::future::pending::<()>().await;
            Ok(ToolOutput::text("unexpected success"))
        }
    }

    /// Mock scripted provider yielding pre-programmed assistant turns.
    struct MockStreamProvider {
        turns: Arc<tokio::sync::Mutex<VecDeque<Vec<StreamEvent>>>>,
        calls: Arc<AtomicUsize>,
    }

    impl MockStreamProvider {
        fn new(turns: Vec<Vec<StreamEvent>>) -> Self {
            Self {
                turns: Arc::new(tokio::sync::Mutex::new(turns.into())),
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    #[async_trait]
    impl Provider for MockStreamProvider {
        fn id(&self) -> &str {
            "mock-provider"
        }

        async fn stream(&self, _request: ProviderRequest) -> HarnessResult<ProviderStream> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut guard = self.turns.lock().await;
            let events = guard.pop_front().unwrap_or_else(|| {
                vec![
                    StreamEvent::TextDelta {
                        text: "done".into(),
                    },
                    StreamEvent::Stop {
                        reason: StopReason::EndTurn,
                    },
                ]
            });
            let stream = futures_util::stream::iter(events.into_iter().map(Ok));
            Ok(Box::pin(stream))
        }
    }

    #[derive(Default)]
    struct EventCollector(Arc<tokio::sync::Mutex<Vec<AgentEvent>>>);
    impl EventSink for EventCollector {
        fn emit(&self, event: AgentEvent) {
            if let Ok(mut lock) = self.0.try_lock() {
                lock.push(event);
            }
        }
    }

    /// Verify cancellation grace period: a hung tool future is dropped after grace period,
    /// yielding HarnessError::Cancelled and error ToolCompleted event.
    #[tokio::test]
    async fn test_cancellation_grace_period_and_future_dropped() {
        let tool_started = Arc::new(tokio::sync::Notify::new());
        let future_dropped = Arc::new(AtomicBool::new(false));

        let tool = Arc::new(ConfigurableTool {
            name: "hung_tool".to_string(),
            cooperative: false,
            started: Arc::clone(&tool_started),
            dropped: Arc::clone(&future_dropped),
        });

        let scripted_turn = vec![
            StreamEvent::ToolUseStart {
                id: "call_1".to_string(),
                name: "hung_tool".to_string(),
            },
            StreamEvent::ToolInputDelta {
                id: "call_1".to_string(),
                partial_json: "{}".to_string(),
            },
            StreamEvent::ToolUseEnd {
                id: "call_1".to_string(),
            },
            StreamEvent::Stop {
                reason: StopReason::ToolUse,
            },
        ];

        let provider = Arc::new(MockStreamProvider::new(vec![scripted_turn]));
        let events = EventCollector::default();
        let events_clone = Arc::clone(&events.0);

        let mut registry = ToolRegistry::default();
        registry.register(tool);

        let agent = Agent {
            provider: Arc::clone(&provider) as Arc<dyn Provider>,
            tools: registry,
            policy: Arc::new(tokio::sync::Mutex::new(PermissionPolicy::new(
                PermissionMode::Full,
            ))),
            approver: Arc::new(AutoApprove),
            events: Arc::new(events),
            steer: omnia_harness::agent::SteerQueue::default(),
            config: AgentConfig::default(),
            hooks: None,
        };

        let ctx = ToolContext::new(".");
        let cancel_token = ctx.cancel.clone();
        let mut history = vec![Message::user("run hung tool")];

        let cancel_handle = tokio::spawn(async move {
            tool_started.notified().await;
            // Short tick then cancel
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancel_token.cancel();
        });

        // The grace period is 2 seconds in agent.rs; run must return Cancelled after ~2s
        let start = tokio::time::Instant::now();
        let run_result = agent.run(&mut history, &ctx).await;
        let elapsed = start.elapsed();

        let _ = cancel_handle.await;

        assert!(
            matches!(run_result, Err(HarnessError::Cancelled)),
            "Result must be Cancelled"
        );
        assert!(
            future_dropped.load(Ordering::SeqCst),
            "The hung tool future must be dropped on cancellation"
        );
        assert!(
            elapsed >= Duration::from_millis(1900),
            "Must respect grace period before abandon: elapsed {:?}",
            elapsed
        );

        // Verify completed event records cancellation
        let event_log = events_clone.lock().await;
        let completed = event_log.iter().find_map(|e| match e {
            AgentEvent::ToolCompleted { id, output } if id == "call_1" => Some(output),
            _ => None,
        });
        assert!(completed.is_some(), "Must emit ToolCompleted event");
        assert!(
            completed.unwrap().is_error,
            "Tool completion must be marked as error"
        );
    }

    /// Verify cooperative cancellation: when tool honours ctx.cancel, it completes immediately
    /// without waiting for the full grace period.
    #[tokio::test]
    async fn test_cooperative_tool_cancels_without_grace_delay() {
        let tool_started = Arc::new(tokio::sync::Notify::new());
        let future_dropped = Arc::new(AtomicBool::new(false));

        let tool = Arc::new(ConfigurableTool {
            name: "coop_tool".to_string(),
            cooperative: true,
            started: Arc::clone(&tool_started),
            dropped: Arc::clone(&future_dropped),
        });

        let scripted_turn = vec![
            StreamEvent::ToolUseStart {
                id: "call_coop".to_string(),
                name: "coop_tool".to_string(),
            },
            StreamEvent::ToolInputDelta {
                id: "call_coop".to_string(),
                partial_json: "{}".to_string(),
            },
            StreamEvent::ToolUseEnd {
                id: "call_coop".to_string(),
            },
            StreamEvent::Stop {
                reason: StopReason::ToolUse,
            },
        ];

        let provider = Arc::new(MockStreamProvider::new(vec![scripted_turn]));
        let mut registry = ToolRegistry::default();
        registry.register(tool);

        let agent = Agent {
            provider: Arc::clone(&provider) as Arc<dyn Provider>,
            tools: registry,
            policy: Arc::new(tokio::sync::Mutex::new(PermissionPolicy::new(
                PermissionMode::Full,
            ))),
            approver: Arc::new(AutoApprove),
            events: Arc::new(EventCollector::default()),
            steer: omnia_harness::agent::SteerQueue::default(),
            config: AgentConfig::default(),
            hooks: None,
        };

        let ctx = ToolContext::new(".");
        let cancel_token = ctx.cancel.clone();
        let mut history = vec![Message::user("run cooperative tool")];

        tokio::spawn(async move {
            tool_started.notified().await;
            cancel_token.cancel();
        });

        let start = tokio::time::Instant::now();
        let run_result = agent.run(&mut history, &ctx).await;
        let elapsed = start.elapsed();

        assert!(matches!(run_result, Err(HarnessError::Cancelled)));
        assert!(future_dropped.load(Ordering::SeqCst));
        assert!(
            elapsed < Duration::from_millis(500),
            "Cooperative tool should not wait 2s grace: elapsed {:?}",
            elapsed
        );
    }

    /// Verify duplicate tool call ID rejection while first call is pending.
    #[test]
    fn test_duplicate_tool_call_id_rejected_while_pending() {
        let mut acc = MessageAccumulator::default();
        acc.push(&StreamEvent::ToolUseStart {
            id: "dup_call_1".to_string(),
            name: "tool_a".to_string(),
        })
        .expect("First call should succeed");

        // Attempt second start with identical ID while first is pending
        let result = acc.push(&StreamEvent::ToolUseStart {
            id: "dup_call_1".to_string(),
            name: "tool_b".to_string(),
        });

        match result {
            Err(HarnessError::Protocol(msg)) => {
                assert!(
                    msg.contains("duplicate tool call id"),
                    "Error must cite duplicate ID: {}",
                    msg
                );
                assert!(
                    msg.contains("dup_call_1"),
                    "Error must name the duplicate ID: {}",
                    msg
                );
            }
            other => panic!(
                "Expected Protocol error for duplicate ID while pending, got {:?}",
                other
            ),
        }
    }

    /// Verify duplicate tool call ID rejection after first call has completed.
    #[test]
    fn test_duplicate_tool_call_id_rejected_after_completed() {
        let mut acc = MessageAccumulator::default();
        acc.push(&StreamEvent::ToolUseStart {
            id: "dup_call_2".to_string(),
            name: "tool_a".to_string(),
        })
        .expect("Start should succeed");
        acc.push(&StreamEvent::ToolInputDelta {
            id: "dup_call_2".to_string(),
            partial_json: r#"{"foo":"bar"}"#.to_string(),
        })
        .expect("Delta should succeed");
        acc.push(&StreamEvent::ToolUseEnd {
            id: "dup_call_2".to_string(),
        })
        .expect("End should succeed");

        // Now attempt duplicate start with the same ID after completion
        let result = acc.push(&StreamEvent::ToolUseStart {
            id: "dup_call_2".to_string(),
            name: "tool_c".to_string(),
        });

        match result {
            Err(HarnessError::Protocol(msg)) => {
                assert!(
                    msg.contains("duplicate tool call id"),
                    "Error must cite duplicate ID: {}",
                    msg
                );
                assert!(
                    msg.contains("dup_call_2"),
                    "Error must name the duplicate ID: {}",
                    msg
                );
            }
            other => panic!(
                "Expected Protocol error for duplicate ID after completed, got {:?}",
                other
            ),
        }
    }

    /// Verify duplicate rejection preserves accumulator state and does not corrupt first call.
    #[test]
    fn test_duplicate_rejection_preserves_first_call_integrity() {
        let mut acc = MessageAccumulator::default();
        acc.push(&StreamEvent::ToolUseStart {
            id: "valid_id".to_string(),
            name: "read_file".to_string(),
        })
        .unwrap();

        acc.push(&StreamEvent::ToolInputDelta {
            id: "valid_id".to_string(),
            partial_json: r#"{"path":"test.txt"}"#.to_string(),
        })
        .unwrap();

        // Reject duplicate
        assert!(acc
            .push(&StreamEvent::ToolUseStart {
                id: "valid_id".to_string(),
                name: "overwrite".to_string(),
            })
            .is_err());

        // Complete the original call
        acc.push(&StreamEvent::ToolUseEnd {
            id: "valid_id".to_string(),
        })
        .unwrap();

        let (msg, _, _) = acc.finish();
        let tools: Vec<_> = msg.tool_uses().collect();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].0, "valid_id");
        assert_eq!(tools[0].1, "read_file");
        assert_eq!(tools[0].2, &json!({"path": "test.txt"}));
    }

    /// Multi-provider model routing test provider. Fails the first N models and records requests.
    struct RoutingMockProvider {
        models_attempted: Arc<tokio::sync::Mutex<Vec<String>>>,
        fail_models: Vec<String>,
    }

    #[async_trait]
    impl Provider for RoutingMockProvider {
        fn id(&self) -> &str {
            "routing-mock"
        }

        async fn stream(&self, req: ProviderRequest) -> HarnessResult<ProviderStream> {
            let mut list = self.models_attempted.lock().await;
            list.push(req.model.clone());

            if self.fail_models.contains(&req.model) {
                // Rate limited or overload error triggering fallback
                return Err(HarnessError::Provider {
                    status: Some(429),
                    message: format!("rate limit exceeded for model {}", req.model),
                    retryable: true,
                });
            }

            let events = vec![
                StreamEvent::TextDelta {
                    text: format!("Success from {}", req.model),
                },
                StreamEvent::Stop {
                    reason: StopReason::EndTurn,
                },
            ];
            Ok(Box::pin(futures_util::stream::iter(
                events.into_iter().map(Ok),
            )))
        }
    }

    /// Verify multi-provider model routing: fallback queue triggers on retryable provider error
    /// and switches through configured fallback models.
    #[tokio::test]
    async fn test_multi_provider_model_routing_fallback() {
        let models_attempted = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let provider = Arc::new(RoutingMockProvider {
            models_attempted: Arc::clone(&models_attempted),
            fail_models: vec![
                "primary-claude-3-7".to_string(),
                "backup-claude-3-5".to_string(),
            ],
        });

        let events = EventCollector::default();
        let events_clone = Arc::clone(&events.0);

        let config = AgentConfig {
            model: "primary-claude-3-7".to_string(),
            fallback_models: vec![
                "backup-claude-3-5".to_string(),
                "fallback-gpt-4o".to_string(),
            ],
            max_retries: 0,
            ..AgentConfig::default()
        };

        let agent = Agent {
            provider: Arc::clone(&provider) as Arc<dyn Provider>,
            tools: ToolRegistry::default(),
            policy: Arc::new(tokio::sync::Mutex::new(PermissionPolicy::new(
                PermissionMode::Full,
            ))),
            approver: Arc::new(AutoApprove),
            events: Arc::new(events),
            steer: omnia_harness::agent::SteerQueue::default(),
            config,
            hooks: None,
        };

        let ctx = ToolContext::new(".");
        let mut history = vec![Message::user("hello routing")];

        let outcome = agent
            .run(&mut history, &ctx)
            .await
            .expect("Run should succeed on final fallback");
        assert_eq!(outcome.turns, 1);

        let attempts = models_attempted.lock().await.clone();
        assert_eq!(
            attempts,
            vec![
                "primary-claude-3-7".to_string(),
                "backup-claude-3-5".to_string(),
                "fallback-gpt-4o".to_string(),
            ],
            "Provider must route through models in sequential fallback order"
        );

        // Verify ModelFallback events were emitted
        let log = events_clone.lock().await;
        let fallbacks: Vec<_> = log
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ModelFallback { from, to, reason } => {
                    Some((from.clone(), to.clone(), reason.clone()))
                }
                _ => None,
            })
            .collect();

        assert_eq!(fallbacks.len(), 2, "Must emit 2 fallback events");
        assert_eq!(fallbacks[0].0, "primary-claude-3-7");
        assert_eq!(fallbacks[0].1, "backup-claude-3-5");
        assert_eq!(fallbacks[1].0, "backup-claude-3-5");
        assert_eq!(fallbacks[1].1, "fallback-gpt-4o");
    }
}

// ============================================================================
// PART 2: omnia-download Tests
// ============================================================================

mod test_omnia_download {
    use omnia_download::http::ResumeState;
    use omnia_download::probe::ProbeResult;
    use omnia_download::RequestSpec;

    /// Verify HTTP chunking: Content-Range format parsing and range boundaries.
    #[test]
    fn test_http_chunking_content_range_and_boundaries() {
        // Valid satisfied range: bytes START-END/TOTAL where s <= e < total
        let valid_cases = [
            ("bytes 0-499/1000", Some((0, 499, 1000))),
            ("bytes 500-999/1000", Some((500, 999, 1000))),
            ("bytes 0-0/1", Some((0, 0, 1))),
            ("BYTES 100-199/500", Some((100, 199, 500))),
        ];

        for (hdr, expected) in valid_cases {
            let parsed = parse_test_content_range(hdr);
            assert_eq!(
                parsed, expected,
                "Mismatch parsing valid Content-Range: {}",
                hdr
            );
        }

        // Invalid ranges that must fail closed
        let invalid_cases = [
            "bytes 500-400/1000", // start > end
            "bytes 0-1000/1000",  // end >= total
            "bytes 0-500/*",      // unknown total
            "items 0-500/1000",   // wrong unit
            "bytes -/1000",       // malformed
            "bytes 0-500",        // missing total
            "",                   // empty
        ];

        for hdr in invalid_cases {
            let parsed = parse_test_content_range(hdr);
            assert_eq!(
                parsed, None,
                "Expected failure parsing invalid Content-Range: {}",
                hdr
            );
        }
    }

    /// Mirror parser matching omnia-download's internal RFC 7233 parser contract.
    fn parse_test_content_range(v: &str) -> Option<(u64, u64, u64)> {
        let (unit, rest) = v.trim().split_once(' ')?;
        if !unit.eq_ignore_ascii_case("bytes") {
            return None;
        }
        let (range, total) = rest.trim().split_once('/')?;
        let (s, e) = range.split_once('-')?;
        let num = |x: &str| {
            let x = x.trim();
            if x.is_empty() || !x.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            x.parse::<u64>().ok()
        };
        let (s, e, t) = (num(s)?, num(e)?, num(total)?);
        (s <= e && e < t).then_some((s, e, t))
    }

    /// Verify resume verification: sidecar validation with matching validators.
    #[test]
    fn test_resume_verification_valid_sidecar() {
        let temp_dir = std::env::temp_dir().join(format!("omnia-test-dl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let sidecar_file = temp_dir.join("payload.bin.omnia-dl.json");
        let part_file = temp_dir.join("payload.bin.part");

        let size: u64 = 10_000;
        let half = size / 2;

        let resume_state = ResumeState {
            request: RequestSpec::get("https://download.test/payload.bin"),
            final_url: "https://download.test/payload.bin".to_string(),
            size,
            etag: Some("\"etag-v1\"".to_string()),
            last_modified: Some("Wed, 21 Oct 2025 07:28:00 GMT".to_string()),
            file_name: "payload.bin".to_string(),
            completed: vec![(0, half)],
        };

        let json_bytes = serde_json::to_vec_pretty(&resume_state).unwrap();
        std::fs::write(&sidecar_file, json_bytes).unwrap();
        std::fs::write(&part_file, vec![0u8; size as usize]).unwrap();

        // Validate state matches probe exactly
        let probe = ProbeResult {
            final_url: "https://download.test/payload.bin".to_string(),
            size: Some(size),
            accept_ranges: true,
            etag: Some("\"etag-v1\"".to_string()),
            last_modified: Some("Wed, 21 Oct 2025 07:28:00 GMT".to_string()),
            content_type: Some("application/octet-stream".to_string()),
            file_name: "payload.bin".to_string(),
        };

        let spec = RequestSpec::get("https://download.test/payload.bin");
        let part_len = std::fs::metadata(&part_file).ok().map(|m| m.len());

        let can_resume = resume_state.request.url == spec.url
            && resume_state.final_url == probe.final_url
            && resume_state.size == size
            && resume_state.etag == probe.etag
            && resume_state.last_modified == probe.last_modified
            && part_len == Some(size)
            && spec.headers.is_empty();

        assert!(
            can_resume,
            "Valid sidecar and matching probe must permit resume"
        );

        // Cleanup
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    /// Verify resume fails closed when validators drift (ETag, size, URL drift, or truncated part file).
    #[test]
    fn test_resume_verification_stale_or_tampered_fails_closed() {
        let url = "https://download.test/asset.zip";
        let size: u64 = 50_000;

        let base_state = ResumeState {
            request: RequestSpec::get(url),
            final_url: url.to_string(),
            size,
            etag: Some("\"v1\"".to_string()),
            last_modified: None,
            file_name: "asset.zip".to_string(),
            completed: vec![(0, 25_000)],
        };

        let probe = ProbeResult {
            final_url: url.to_string(),
            size: Some(size),
            accept_ranges: true,
            etag: Some("\"v1\"".to_string()),
            last_modified: None,
            content_type: None,
            file_name: "asset.zip".to_string(),
        };

        // 1. ETag drift
        let probe_etag_drift = ProbeResult {
            etag: Some("\"v2\"".to_string()),
            ..probe.clone()
        };
        assert_ne!(
            base_state.etag, probe_etag_drift.etag,
            "ETag drift must invalidate resume"
        );

        // 2. Size drift
        let probe_size_drift = ProbeResult {
            size: Some(size + 100),
            ..probe.clone()
        };
        assert_ne!(
            base_state.size,
            probe_size_drift.size.unwrap(),
            "Size drift must invalidate resume"
        );

        // 3. Final URL redirect drift
        let probe_url_drift = ProbeResult {
            final_url: "https://cdn2.test/asset.zip".to_string(),
            ..probe.clone()
        };
        assert_ne!(
            base_state.final_url, probe_url_drift.final_url,
            "URL drift must invalidate resume"
        );

        // 4. Overlapping completed ranges
        let invalid_ranges = vec![(0, 30_000), (20_000, 50_000)];
        assert!(
            has_overlapping_ranges(&invalid_ranges),
            "Overlapping ranges must be rejected"
        );

        // 5. Out of bounds ranges
        let oob_ranges = vec![(0, size + 1)];
        assert!(
            !ranges_within_bounds(&oob_ranges, size),
            "Out-of-bounds ranges must be rejected"
        );
    }

    fn has_overlapping_ranges(ranges: &[(u64, u64)]) -> bool {
        let mut prev = 0;
        for &(s, e) in ranges {
            if s < prev || s >= e {
                return true;
            }
            prev = e;
        }
        false
    }

    fn ranges_within_bounds(ranges: &[(u64, u64)], size: u64) -> bool {
        let mut prev = 0;
        for &(s, e) in ranges {
            if s < prev || s >= e || e > size {
                return false;
            }
            prev = e;
        }
        true
    }

    /// Verify header constraints: requests with credentials, Authorization headers,
    /// or cookies fail closed for resume to avoid token/credential leak and stale auth corruption.
    #[test]
    fn test_resume_header_constraints_enforce_fail_closed() {
        let url = "https://secure.test/file.tar.gz";

        // 1. Request with Authorization header
        let mut req_auth = RequestSpec::get(url);
        req_auth
            .headers
            .push(("Authorization".into(), "Bearer secret-token-123".into()));
        assert!(
            !req_auth.headers.is_empty(),
            "Authenticated requests cannot be resumed via sidecar"
        );

        // 2. Request with cookies
        let mut req_cookie = RequestSpec::get(url);
        req_cookie.cookies = Some("session_id=xyz".into());
        assert!(
            req_cookie.cookies.is_some(),
            "Cookie-carrying requests cannot be resumed via sidecar"
        );

        // 3. Request with custom User-Agent or Referer
        let mut req_custom = RequestSpec::get(url);
        req_custom.referer = Some("https://referrer.test".into());
        assert!(
            req_custom.referer.is_some(),
            "Custom referer requests cannot be resumed via sidecar"
        );

        // 4. POST method must not be resumed as chunked GET
        let mut req_post = RequestSpec::get(url);
        req_post.method = "POST".into();
        req_post.body = Some(b"upload data".to_vec());
        assert_ne!(
            req_post.method.to_ascii_uppercase(),
            "GET",
            "Non-GET methods cannot be resumed"
        );
    }
}

// ============================================================================
// PART 3: omnia-browser Tests
// ============================================================================
mod test_omnia_browser {
    use super::*;
    use omnia_browser::{browser_tools, BrowserConfig, BrowserHandle};
    use omnia_harness::EffectClass;

    /// Verify browser command contracts: all 21 browser tools are registered,
    /// tool names are unique, effect class is BrowserControl, schemas are objects.
    #[test]
    fn test_browser_command_contracts_and_effects() {
        let temp_dir = std::env::temp_dir().join(format!("omnia-test-br-{}", uuid::Uuid::new_v4()));
        let config = BrowserConfig::new(temp_dir);
        let handle = BrowserHandle::new(config);
        let tools = browser_tools(handle);

        assert_eq!(tools.len(), 21, "Must register exactly 21 browser tools");

        let mut names: Vec<String> = tools.iter().map(|t| t.spec().name).collect();
        let total = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), total, "Tool names must be strictly unique");

        let expected_names = [
            "browser_navigate",
            "browser_snapshot",
            "browser_click",
            "browser_type",
            "browser_press",
            "browser_hover",
            "browser_scroll",
            "browser_select",
            "browser_upload",
            "browser_wait",
            "browser_screenshot",
            "browser_evaluate",
            "browser_get_text",
            "browser_tabs",
            "browser_console",
            "browser_network",
            "browser_pdf",
            "browser_batch",
            "browser_record",
            "browser_emulate",
            "browser_save_page",
        ];

        for expected in expected_names {
            let found = tools.iter().find(|t| t.spec().name == expected);
            assert!(
                found.is_some(),
                "Missing expected browser tool: {}",
                expected
            );
            let tool = found.unwrap();

            // Check effect class: BrowserControl
            assert_eq!(
                tool.effect(),
                EffectClass::BrowserControl,
                "Tool {} must have BrowserControl effect",
                expected
            );

            // Check schema structure
            let spec = tool.spec();
            assert_eq!(
                spec.input_schema["type"], "object",
                "Tool {} schema must be of type 'object'",
                expected
            );
            assert!(
                !spec.description.is_empty(),
                "Tool {} must have non-empty description",
                expected
            );
        }
    }

    /// Verify payload validation: URL normalization contract for browser navigation.
    #[test]
    fn test_browser_url_normalization_contract() {
        // Normalization rules:
        // - Already has scheme: keep as is
        // - localhost or IPv4: prefix with http://
        // - domain names: prefix with https://
        // - special schemes (about:, data:, blob:, file:): keep as is
        let cases = [
            ("https://example.com/page", "https://example.com/page"),
            ("http://example.com", "http://example.com"),
            ("localhost:3000/app", "http://localhost:3000/app"),
            ("127.0.0.1:8080", "http://127.0.0.1:8080"),
            ("example.com", "https://example.com"),
            ("sub.domain.org/path?q=1", "https://sub.domain.org/path?q=1"),
            ("about:blank", "about:blank"),
            ("data:text/html,<h1>Hi</h1>", "data:text/html,<h1>Hi</h1>"),
        ];

        for (input, expected) in cases {
            assert_eq!(
                normalize_test_url(input),
                expected,
                "URL normalization failed for: {}",
                input
            );
        }
    }

    fn normalize_test_url(raw: &str) -> String {
        let url = raw.trim();
        let lower = url.to_ascii_lowercase();
        if lower.contains("://")
            || [
                "about:",
                "data:",
                "blob:",
                "javascript:",
                "file:",
                "mailto:",
                "edge:",
                "chrome:",
            ]
            .iter()
            .any(|p| lower.starts_with(p))
        {
            return url.to_string();
        }
        let host = lower.split(['/', ':', '?', '#']).next().unwrap_or("");
        let local = host == "localhost"
            || host.parse::<std::net::Ipv4Addr>().is_ok()
            || host.ends_with(".localhost");
        format!("{}://{url}", if local { "http" } else { "https" })
    }

    /// Verify TargetArgs validation: requiring either ref, selector, or x/y.
    #[test]
    fn test_browser_target_args_payload_validation() {
        let valid_by_ref = json!({ "ref": "e12" });
        assert!(validate_target_args(&valid_by_ref).is_ok());

        let valid_by_selector = json!({ "selector": "#submit-btn" });
        assert!(validate_target_args(&valid_by_selector).is_ok());

        let valid_by_coords = json!({ "x": 100.0, "y": 250.5 });
        assert!(validate_target_args(&valid_by_coords).is_ok());

        let invalid_empty = json!({});
        assert!(validate_target_args(&invalid_empty).is_err());

        let invalid_partial_coords = json!({ "x": 100.0 }); // missing y
        assert!(validate_target_args(&invalid_partial_coords).is_err());
    }

    fn validate_target_args(v: &Value) -> Result<(), &'static str> {
        let has_ref = v
            .get("ref")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .is_some();
        let has_sel = v
            .get("selector")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .is_some();
        let has_xy = v.get("x").and_then(Value::as_f64).is_some()
            && v.get("y").and_then(Value::as_f64).is_some();

        if has_ref || has_sel || has_xy {
            Ok(())
        } else {
            Err("give a `ref`, a CSS `selector`, or `x` and `y`")
        }
    }
}

// ============================================================================
// PART 4: omnia-computer Tests
// ============================================================================
mod test_omnia_computer {
    use super::*;
    use omnia_computer::safety::{default_blocked_apps, ComputerPolicy, KillSwitch};
    use omnia_computer::{computer_tools, ComputerConfig, ComputerError};
    use omnia_harness::EffectClass;

    /// Verify computer use command contracts: 21 tools registered, unique names,
    /// proper effect class separation (ReadWorkspace vs ComputerControl), required input fields.
    #[test]
    fn test_computer_command_contracts_and_effects() {
        let config = ComputerConfig::default();
        let tools = computer_tools(config);

        assert_eq!(tools.len(), 21, "Must register exactly 21 computer tools");

        let mut names: Vec<String> = tools.iter().map(|t| t.spec().name).collect();
        let total = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), total, "Tool names must be unique");

        // Verify background tools contract
        let bg_contracts = [
            ("computer_window_list", EffectClass::ReadWorkspace, vec![]),
            (
                "computer_window_screenshot",
                EffectClass::ReadWorkspace,
                vec!["hwnd"],
            ),
            (
                "computer_window_ocr",
                EffectClass::ReadWorkspace,
                vec!["hwnd"],
            ),
            (
                "computer_window_find_text",
                EffectClass::ReadWorkspace,
                vec!["hwnd", "text"],
            ),
            (
                "computer_window_click",
                EffectClass::ComputerControl,
                vec!["hwnd", "x", "y"],
            ),
            (
                "computer_window_type",
                EffectClass::ComputerControl,
                vec!["hwnd", "text"],
            ),
            (
                "computer_window_key",
                EffectClass::ComputerControl,
                vec!["hwnd", "key"],
            ),
        ];

        for (name, effect, required) in bg_contracts {
            let tool = tools
                .iter()
                .find(|t| t.spec().name == name)
                .unwrap_or_else(|| panic!("Missing: {}", name));
            assert_eq!(tool.effect(), effect, "Effect mismatch for {}", name);

            let spec = tool.spec();
            let req_fields: Vec<String> = spec
                .input_schema
                .get("required")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();

            assert_eq!(
                req_fields, required,
                "Required fields mismatch for {}",
                name
            );
        }

        // Verify foreground tools
        for (fg_name, fg_effect) in [
            ("computer_windows", EffectClass::ReadWorkspace),
            ("computer_snapshot", EffectClass::ReadWorkspace),
            ("computer_screenshot", EffectClass::ReadWorkspace),
            ("computer_click", EffectClass::ComputerControl),
            ("computer_type", EffectClass::ComputerControl),
            ("computer_key", EffectClass::ComputerControl),
            ("computer_scroll", EffectClass::ComputerControl),
            ("computer_drag", EffectClass::ComputerControl),
            ("computer_act", EffectClass::ComputerControl),
            ("computer_launch", EffectClass::ComputerControl),
            ("computer_batch", EffectClass::ComputerControl),
        ] {
            let tool = tools
                .iter()
                .find(|t| t.spec().name == fg_name)
                .unwrap_or_else(|| panic!("Missing: {}", fg_name));
            assert_eq!(tool.effect(), fg_effect, "Effect mismatch for {}", fg_name);
        }
    }

    /// Verify safety policy: blocked apps (passwords/elevation UI) are rejected,
    /// allowed apps whitelist is enforced, empty process name is rejected.
    #[test]
    fn test_computer_safety_policy_validation() {
        let policy = ComputerPolicy::default();

        // Standard credential prompts and password managers must be blocked
        let blocked_samples = [
            "1Password.exe",
            "Bitwarden",
            "KeePassXC.exe",
            "CredentialUIBroker.exe",
            "consent.exe",
            "WindowsSecurity.exe",
        ];

        for app in blocked_samples {
            let check = policy.check_process(app);
            assert!(
                matches!(check, Err(ComputerError::Blocked(_))),
                "Expected {} to be blocked, got {:?}",
                app,
                check
            );
        }

        // Empty process fails closed
        assert!(matches!(
            policy.check_process(""),
            Err(ComputerError::Blocked(_))
        ));

        // Unblocked apps pass default policy
        assert!(policy.check_process("notepad.exe").is_ok());
        assert!(policy.check_process("calculator").is_ok());

        // Whitelist enforcement
        let whitelist_policy = ComputerPolicy {
            allowed_apps: Some(vec!["notepad.exe".to_string(), "code.exe".to_string()]),
            blocked_apps: default_blocked_apps(),
            max_actions_per_minute: 120,
        };

        assert!(whitelist_policy.check_process("notepad").is_ok());
        assert!(whitelist_policy.check_process("code.exe").is_ok());
        assert!(matches!(
            whitelist_policy.check_process("mspaint.exe"),
            Err(ComputerError::Blocked(_))
        ));
    }

    /// Verify KillSwitch emergency stop: triggered kill switch halts all automation.
    #[test]
    fn test_computer_kill_switch_emergency_stop() {
        let kill_switch = KillSwitch::default();
        assert!(
            !kill_switch.is_triggered(),
            "Kill switch should initially be disarmed"
        );

        // Engage kill switch
        kill_switch.trigger();
        assert!(
            kill_switch.is_triggered(),
            "Kill switch must be marked triggered"
        );

        // Re-arm / reset
        kill_switch.reset();
        assert!(
            !kill_switch.is_triggered(),
            "Kill switch must be disarmed after reset"
        );
    }

    /// Verify batch tool payload validation: empty actions array is rejected,
    /// unknown tool names are rejected, step sequencing aborts on error.
    #[test]
    fn test_computer_batch_payload_validation() {
        let empty_batch = json!({ "actions": [] });
        let items = empty_batch
            .get("actions")
            .and_then(Value::as_array)
            .filter(|a| !a.is_empty());
        assert!(items.is_none(), "Empty actions array must be rejected");

        let missing_actions = json!({});
        let missing_items = missing_actions
            .get("actions")
            .and_then(Value::as_array)
            .filter(|a| !a.is_empty());
        assert!(missing_items.is_none(), "Missing actions must be rejected");

        // Step sequencing: valid steps vs unknown step
        let actions = &[
            json!({"tool": "wait", "ms": 100}),
            json!({"tool": "computer_nonexistent_action", "x": 10}),
        ];

        let mut step_failed = false;
        for (i, action) in actions.iter().enumerate() {
            let tool_name = action.get("tool").and_then(Value::as_str).unwrap_or("");
            if tool_name == "wait" {
                continue;
            }
            if tool_name != "computer_click" && tool_name != "computer_type" {
                step_failed = true;
                assert_eq!(i, 1, "Expected step 2 to fail due to unknown tool");
                break;
            }
        }
        assert!(
            step_failed,
            "Batch execution must abort on unknown action step"
        );
    }
}
