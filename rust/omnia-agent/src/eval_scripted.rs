//! Deterministic Offline Scripted Evaluation Harness (`ScriptedProvider` & `ScriptedApprover`).
//!
//! Runs end-to-end verification scenarios directly against real [`ToolRuntime`], [`PermissionsEngine`],
//! [`TurnCheckpointStore`], [`HookRegistry`], [`crate::acp_http`], [`crate::builtin_stem`], and
//! [`crate::office_reader`] with zero network calls and zero flaky wall-clock assumptions.

use crate::tools::{InteractiveApprover, ToolExecOutput, ToolRuntime};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

/// One scripted tool invocation expected during an offline evaluation scenario.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptedTurn {
    pub tool_name: String,
    pub arguments: Value,
    pub expect_error: bool,
    pub must_contain: Vec<String>,
}

/// Deterministic pass/fail receipt emitted by [`ScriptedProvider::run_against`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalScenarioReceipt {
    pub scenario: String,
    pub turns_executed: usize,
    pub passed: bool,
    pub failures: Vec<String>,
}

/// Offline deterministic scripted provider driving a sequence of tool calls against [`ToolRuntime`].
#[derive(Debug, Clone)]
pub struct ScriptedProvider {
    pub scenario: String,
    turns: VecDeque<ScriptedTurn>,
    observed: Vec<ToolExecOutput>,
}

impl ScriptedProvider {
    #[must_use]
    pub fn new(scenario: impl Into<String>, turns: Vec<ScriptedTurn>) -> Self {
        Self {
            scenario: scenario.into(),
            turns: VecDeque::from(turns),
            observed: Vec::new(),
        }
    }

    #[must_use]
    pub fn observed_outputs(&self) -> &[ToolExecOutput] {
        &self.observed
    }

    /// Executes every scripted turn sequentially against `runtime` and verifies assertions.
    pub async fn run_against(&mut self, runtime: &ToolRuntime) -> EvalScenarioReceipt {
        let mut failures = Vec::new();
        let mut executed = 0usize;

        while let Some(step) = self.turns.pop_front() {
            let out = runtime.execute(&step.tool_name, &step.arguments).await;
            if out.is_error != step.expect_error {
                failures.push(format!(
                    "turn {} (`{}`): expected is_error={}, got is_error={} (content: {})",
                    executed + 1,
                    step.tool_name,
                    step.expect_error,
                    out.is_error,
                    out.content.chars().take(240).collect::<String>()
                ));
            }
            for needle in &step.must_contain {
                if !out.content.contains(needle) {
                    failures.push(format!(
                        "turn {} (`{}`): output missing expected substring `{needle}` (got: {})",
                        executed + 1,
                        step.tool_name,
                        out.content.chars().take(240).collect::<String>()
                    ));
                }
            }
            self.observed.push(out);
            executed += 1;
        }

        EvalScenarioReceipt {
            scenario: self.scenario.clone(),
            turns_executed: executed,
            passed: failures.is_empty(),
            failures,
        }
    }
}

/// Deterministic scripted approval responder recording every interactive prompt.
#[derive(Clone, Default)]
pub struct ScriptedApprover {
    decisions: Arc<Mutex<VecDeque<bool>>>,
    requests: Arc<Mutex<Vec<(String, String)>>>,
    default_decision: bool,
}

impl ScriptedApprover {
    #[must_use]
    pub fn new(decisions: Vec<bool>, default_decision: bool) -> Self {
        Self {
            decisions: Arc::new(Mutex::new(VecDeque::from(decisions))),
            requests: Arc::new(Mutex::new(Vec::new())),
            default_decision,
        }
    }

    #[must_use]
    pub fn into_callback(&self) -> InteractiveApprover {
        let decisions = Arc::clone(&self.decisions);
        let requests = Arc::clone(&self.requests);
        let fallback = self.default_decision;
        Arc::new(move |tool: String, target: String| {
            let decisions = Arc::clone(&decisions);
            let requests = Arc::clone(&requests);
            Box::pin(async move {
                if let Ok(mut log) = requests.lock() {
                    log.push((tool, target));
                }
                decisions
                    .lock()
                    .ok()
                    .and_then(|mut q| q.pop_front())
                    .unwrap_or(fallback)
            })
        })
    }

    #[must_use]
    pub fn recorded_requests(&self) -> Vec<(String, String)> {
        self.requests.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtin_stem::MAX_EPISTEMIC_SCORE;
    use crate::checkpoint::TurnCheckpointStore;
    use crate::context::WorkspaceContextBundle;
    use crate::edit::FileReadTracker;
    use crate::graph_locator::WorkspaceGraphIndex;
    use crate::hooks::{HookEvent, HookRegistry, HookSpec};
    use crate::office_reader::{build_test_zip, OFFICE_MAX_UNCOMPRESSED_BYTES};
    use crate::permissions::{ApprovalMode, PermissionsEngine};
    use crate::plugin::PluginRegistry;
    use crate::tools::FileMutationLocks;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::time::{Duration, Instant};

    fn make_temp_runtime(
        prefix: &str,
        approval: ApprovalMode,
        trusted: bool,
        approver: Option<InteractiveApprover>,
    ) -> (PathBuf, ToolRuntime) {
        let dir = std::env::temp_dir().join(format!("{prefix}_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(&dir)));
        let ctx = Arc::new(WorkspaceContextBundle::discover(&dir));
        let rt = ToolRuntime::new(
            dir.clone(),
            approval,
            trusted,
            PermissionsEngine::default_rules(),
            graph,
            ctx,
            None,
            approver,
            Arc::new(AtomicBool::new(false)),
        );
        (dir, rt)
    }

    #[tokio::test]
    async fn scripted_eval_yolo_defaults_and_token0_prefix_invariance() {
        assert!(PermissionsEngine::default_rules().is_empty());

        let reg = PluginRegistry::with_default_pillars();
        assert_eq!(reg.active_tools(false).len(), 7);
        assert_eq!(reg.active_tools_with_deferred(false, true).len(), 10);

        let approver = ScriptedApprover::new(vec![false], false);
        let (dir, rt) = make_temp_runtime(
            "eval_yolo",
            ApprovalMode::Yolo,
            true,
            Some(approver.into_callback()),
        );

        let mut provider = ScriptedProvider::new(
            "yolo-zero-nerf",
            vec![
                ScriptedTurn {
                    tool_name: "write_file".into(),
                    arguments: json!({ "path": "hello.txt", "content": "zero-nerf ok\n" }),
                    expect_error: false,
                    must_contain: vec!["Wrote 'hello.txt'".into()],
                },
                ScriptedTurn {
                    tool_name: "discover_tools".into(),
                    arguments: json!({ "query": "stem_verify matrix redos" }),
                    expect_error: false,
                    must_contain: vec!["stem_verify".into()],
                },
            ],
        );

        let receipt = provider.run_against(&rt).await;
        assert!(receipt.passed, "failures: {:?}", receipt.failures);
        // Default YOLO never interrupts with interactive prompts when rules are empty.
        assert!(approver.recorded_requests().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn scripted_eval_acp_http_invalid_mode_returns_32602_preserving_yolo() {
        let dir = std::env::temp_dir().join(format!("eval_acp_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut state = crate::acp_http::new_acp_state(
            Some("openai/offline".into()),
            Some("http://127.0.0.1:1/v1".into()),
            Some("fixture-offline-key".into()),
        );
        state.store = None;

        let created = crate::acp_http::dispatch_rpc(
            json!({"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd": dir}}),
            &state,
            None,
        )
        .await
        .unwrap();
        let sid = created["result"]["sessionId"].as_str().unwrap().to_owned();

        let err_resp = crate::acp_http::dispatch_rpc(
            json!({
                "jsonrpc":"2.0",
                "id":2,
                "method":"session/set_mode",
                "params":{"sessionId": sid, "modeId": "unknown-bogus-mode"}
            }),
            &state,
            None,
        )
        .await
        .unwrap();
        assert_eq!(err_resp["error"]["code"], -32602);

        let entry = state.sessions.lock().await.get(&sid).unwrap().clone();
        let eng = entry.0.lock().await;
        assert_eq!(eng.tool_runtime.approval_mode, ApprovalMode::Yolo);
        assert!(eng.tool_runtime.workspace_trusted);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn scripted_eval_stem_verify_direct_and_deferred_extension() {
        let (dir, rt) = make_temp_runtime("eval_stem", ApprovalMode::Yolo, true, None);
        let mut provider = ScriptedProvider::new(
            "stem-verify-suite",
            vec![
                ScriptedTurn {
                    tool_name: "stem_verify".into(),
                    arguments: json!({ "mode": "calc", "expression": "6! / 12 + sqrt(81)" }),
                    expect_error: false,
                    must_contain: vec!["69".into()],
                },
                ScriptedTurn {
                    tool_name: "invoke_extension_tool".into(),
                    arguments: json!({
                        "name": "stem_verify",
                        "arguments": { "mode": "redos", "pattern": "(a+)+" }
                    }),
                    expect_error: false,
                    must_contain: vec!["nested_quantifier".into(), "\"safe\": false".into()],
                },
                ScriptedTurn {
                    tool_name: "stem_verify".into(),
                    arguments: json!({
                        "mode": "syntax",
                        "language": "rust",
                        "code": "fn f<'a>(s: &'a str) -> &'static str { \"ok\" }"
                    }),
                    expect_error: false,
                    must_contain: vec!["\"balanced\": true".into()],
                },
                ScriptedTurn {
                    tool_name: "stem_verify".into(),
                    arguments: json!({
                        "mode": "verify_claims",
                        "draft": "This summary has no math or citations.",
                        "sources": []
                    }),
                    expect_error: false,
                    must_contain: vec!["\"abstain-recommended\"".into()],
                },
            ],
        );

        let receipt = provider.run_against(&rt).await;
        assert!(receipt.passed, "failures: {:?}", receipt.failures);

        let claim_val: Value =
            serde_json::from_str(&provider.observed_outputs()[3].content).unwrap();
        assert_ne!(claim_val["verdict"], "verified");
        assert!(claim_val["epistemicScore"].as_f64().unwrap() <= MAX_EPISTEMIC_SCORE);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn scripted_eval_office_docx_ipynb_and_50mib_zip_bomb_guard() {
        let (dir, rt) = make_temp_runtime("eval_office", ApprovalMode::Yolo, true, None);

        // 1. Valid Deflate .docx
        let docx_xml = br#"<w:document><w:body><w:p><w:r><w:t>Omnia SOTA Harness</w:t></w:r></w:p></w:body></w:document>"#;
        std::fs::write(
            dir.join("brief.docx"),
            build_test_zip(&[("word/document.xml", docx_xml, true)]),
        )
        .unwrap();

        // 2. Valid .ipynb
        std::fs::write(
            dir.join("analysis.ipynb"),
            br#"{"cells":[{"cell_type":"code","source":["x = 2 + 2\nprint(x)"],"outputs":[{"text":["4\n"]}]}]}"#,
        )
        .unwrap();

        // 3. Real > 50 MiB Deflate zip bomb (compresses to ~52 KiB on disk!)
        let bomb_raw = vec![b'0'; OFFICE_MAX_UNCOMPRESSED_BYTES + 1024 * 1024];
        let bomb_zip = build_test_zip(&[("word/document.xml", &bomb_raw, true)]);
        assert!(bomb_zip.len() < 256 * 1024);
        std::fs::write(dir.join("bomb.docx"), &bomb_zip).unwrap();

        let mut provider = ScriptedProvider::new(
            "office-and-zip-bomb",
            vec![
                ScriptedTurn {
                    tool_name: "read_file".into(),
                    arguments: json!({ "path": "brief.docx" }),
                    expect_error: false,
                    must_contain: vec!["Omnia SOTA Harness".into()],
                },
                ScriptedTurn {
                    tool_name: "read_file".into(),
                    arguments: json!({ "path": "analysis.ipynb" }),
                    expect_error: false,
                    must_contain: vec!["Cell 1 [code]".into(), "print(x)".into()],
                },
                ScriptedTurn {
                    tool_name: "read_file".into(),
                    arguments: json!({ "path": "bomb.docx" }),
                    expect_error: true,
                    must_contain: vec!["zip-bomb guard".into()],
                },
            ],
        );

        let receipt = provider.run_against(&rt).await;
        assert!(receipt.passed, "failures: {:?}", receipt.failures);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scripted_eval_compaction_safe_checkpoint_rewind() {
        let dir = std::env::temp_dir().join(format!("eval_cp_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("state.txt");
        std::fs::write(&f, "v1\n").unwrap();

        let mut cp = TurnCheckpointStore::new("eval-sess", None);
        let k1 = cp.record_timeline_point(1, 1, "initial");
        cp.record_pre_mutation(1, "state.txt", &f);
        std::fs::write(&f, "v2\n").unwrap();

        let k2 = cp.record_timeline_point(2, 6, "post-edit");
        cp.record_pre_mutation(2, "state.txt", &f);
        std::fs::write(&f, "v3\n").unwrap();

        let outcome = cp.rebase_compaction(4, 1, Some("anchor-1".into()));
        assert_eq!(outcome.archived_entries, 1);
        assert_eq!(outcome.rebased_entries, 1);
        assert!(cp.prepare_conversation_rewind(k1).is_err());

        let staged = cp.prepare_conversation_rewind(k2).unwrap();
        assert_eq!(staged.target_transcript_index, 3);
        let committed = cp.confirm_history(k2).unwrap();
        assert_eq!(committed.target_key, k2);

        let tracker = FileReadTracker::new();
        let partial = cp.rollback_to_turn_partial(1, &dir, &tracker);
        assert_eq!(partial.restored, vec!["state.txt".to_owned()]);
        assert!(partial.failed.is_empty());
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "v2\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn scripted_eval_hook_timeout_and_file_mutation_locks() {
        let dir = std::env::temp_dir().join(format!("eval_hooks_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        // 1. Hook timeout kills entire process tree cleanly without hanging.
        let hooks = HookRegistry::new(&dir);
        let slow = if cfg!(windows) {
            "ping -n 20 127.0.0.1 >nul"
        } else {
            "sleep 20"
        };
        hooks.register_command(HookSpec {
            id: "eval-timeout".into(),
            event: HookEvent::PostToolUse,
            matcher: None,
            command: slow.into(),
            timeout_ms: 1_200,
            enabled: true,
            fail_closed: false,
            source: "eval".into(),
        });
        let t0 = Instant::now();
        let out = hooks
            .dispatch(HookEvent::PostToolUse, Some("shell"), json!({}))
            .await;
        assert!(out.warnings.iter().any(|w| w.contains("timed out")));
        assert!(t0.elapsed() < Duration::from_secs(6));

        // 2. Weak-ref FileMutationLocks serializes concurrent edits and prunes cleanly on drop.
        let locks = Arc::new(FileMutationLocks::default());
        let cancel = Arc::new(AtomicBool::new(false));
        let target = dir.join("shared.rs");
        let g1 = locks.acquire(&target, &cancel).await.unwrap();
        assert_eq!(locks.active_lock_count(), 1);
        let locks_clone = Arc::clone(&locks);
        let cancel_clone = Arc::clone(&cancel);
        let target_clone = target.clone();
        let waiter = tokio::spawn(async move {
            let _g2 = locks_clone.acquire(&target_clone, &cancel_clone).await.unwrap();
            Instant::now()
        });
        tokio::time::sleep(Duration::from_millis(80)).await;
        let released_at = Instant::now();
        drop(g1);
        let acquired_at = waiter.await.unwrap();
        assert!(acquired_at >= released_at);
        assert_eq!(locks.active_lock_count(), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
