use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use anyhow::{bail, Result};
use omnia_core::{sha256_bytes, sha256_hex, SecretRedactor};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Semaphore;

use crate::checkpoint::{TestOutcomeTransition, TurnCheckpointStore};
use crate::edit::FileReadTracker;
use crate::swarm_runtime::{WorktreeHandle, WorktreeIsolationConfig, WorktreeManager};

const HMAC_BLOCK_SIZE: usize = 64;
const EXECUTION_RECEIPT_SCHEMA: &str = "omnia.execution_receipt.v1";

/// Pure RFC-2104 HMAC-SHA256 using `omnia_core::sha256_bytes`.
#[must_use]
pub fn hmac_sha256_bytes(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut k0 = [0u8; HMAC_BLOCK_SIZE];
    if key.len() > HMAC_BLOCK_SIZE {
        let hashed = sha256_bytes(key);
        k0[..32].copy_from_slice(&hashed);
    } else {
        k0[..key.len()].copy_from_slice(key);
    }
    let mut ipad = Vec::with_capacity(HMAC_BLOCK_SIZE + message.len());
    for &b in &k0 {
        ipad.push(b ^ 0x36);
    }
    ipad.extend_from_slice(message);
    let inner = sha256_bytes(&ipad);

    let mut opad = [0u8; HMAC_BLOCK_SIZE + 32];
    for (i, &b) in k0.iter().enumerate() {
        opad[i] = b ^ 0x5c;
    }
    opad[HMAC_BLOCK_SIZE..].copy_from_slice(&inner);
    sha256_bytes(&opad)
}

#[must_use]
pub fn hmac_sha256_hex(key: &[u8], message: &[u8]) -> String {
    let bytes = hmac_sha256_bytes(key, message);
    let mut out = String::with_capacity(64);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Cryptographically signed execution receipt binding command, exit code, stdout/stderr digests, and timestamp.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionReceipt {
    pub schema_version: String,
    pub command: String,
    pub exit_code: i32,
    pub stdout_sha256: String,
    pub stderr_sha256: String,
    pub timestamp_ms: i64,
    pub signature_hmac_sha256: String,
}

fn canonical_receipt_bytes(
    schema: &str,
    command: &str,
    exit_code: i32,
    stdout_sha256: &str,
    stderr_sha256: &str,
    timestamp_ms: i64,
) -> Vec<u8> {
    format!("{schema}\n{command}\n{exit_code}\n{stdout_sha256}\n{stderr_sha256}\n{timestamp_ms}")
        .into_bytes()
}

#[must_use]
pub fn sign_execution_receipt(
    key: &[u8],
    command: &str,
    exit_code: i32,
    stdout: &[u8],
    stderr: &[u8],
    timestamp_ms: i64,
) -> ExecutionReceipt {
    let clean_cmd = SecretRedactor::redact(command);
    let stdout_sha256 = sha256_hex(stdout);
    let stderr_sha256 = sha256_hex(stderr);
    let msg = canonical_receipt_bytes(
        EXECUTION_RECEIPT_SCHEMA,
        &clean_cmd,
        exit_code,
        &stdout_sha256,
        &stderr_sha256,
        timestamp_ms,
    );
    ExecutionReceipt {
        schema_version: EXECUTION_RECEIPT_SCHEMA.to_owned(),
        command: clean_cmd,
        exit_code,
        stdout_sha256,
        stderr_sha256,
        timestamp_ms,
        signature_hmac_sha256: hmac_sha256_hex(key, &msg),
    }
}

#[must_use]
pub fn verify_execution_receipt(key: &[u8], receipt: &ExecutionReceipt) -> bool {
    let msg = canonical_receipt_bytes(
        &receipt.schema_version,
        &receipt.command,
        receipt.exit_code,
        &receipt.stdout_sha256,
        &receipt.stderr_sha256,
        receipt.timestamp_ms,
    );
    let expected = hmac_sha256_hex(key, &msg);
    let eb = expected.as_bytes();
    let ab = receipt.signature_hmac_sha256.as_bytes();
    if eb.len() != ab.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in eb.iter().zip(ab.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlopLanguage {
    Rust,
    Python,
    TypeScript,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlopKind {
    TodoMacro,
    UnimplementedMacro,
    PanicNotImplemented,
    EmptyStub,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlopFinding {
    pub line: usize,
    pub kind: SlopKind,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlopScanReport {
    pub clean: bool,
    pub findings: Vec<SlopFinding>,
}

/// Fast comment/string-aware slop detector migrated from retired `contract_verifier.rs`.
#[must_use]
pub fn scan_source_for_slop(source: &str, language: SlopLanguage) -> SlopScanReport {
    let mut findings = Vec::new();
    let mut in_block_comment = false;
    for (idx, line) in source.lines().enumerate() {
        let mut t = line.trim();
        if language != SlopLanguage::Python {
            if in_block_comment {
                if let Some(end) = t.find("*/") {
                    t = t[end + 2..].trim();
                    in_block_comment = false;
                } else {
                    continue;
                }
            }
            if t.starts_with("/*") {
                if let Some(end) = t.find("*/") {
                    t = t[end + 2..].trim();
                } else {
                    in_block_comment = true;
                    continue;
                }
            }
            if t.starts_with("//") {
                continue;
            }
        } else if t.starts_with('#') {
            continue;
        }
        // Strip inline quoted strings crudely before macro detection so test assertions don't false-positive.
        let unquoted = strip_double_quoted_literals(t);
        if unquoted.contains("todo!()") || unquoted.contains("TODO!()") {
            findings.push(SlopFinding {
                line: idx + 1,
                kind: SlopKind::TodoMacro,
                snippet: t.chars().take(80).collect(),
            });
        }
        if unquoted.contains("unimplemented!()") {
            findings.push(SlopFinding {
                line: idx + 1,
                kind: SlopKind::UnimplementedMacro,
                snippet: t.chars().take(80).collect(),
            });
        }
        if t.contains("panic!(\"not implemented") || t.contains("NotImplementedError") {
            findings.push(SlopFinding {
                line: idx + 1,
                kind: SlopKind::PanicNotImplemented,
                snippet: t.chars().take(80).collect(),
            });
        }
        if matches!(language, SlopLanguage::Rust) && t.starts_with("pub fn ") && t.ends_with("{}") {
            findings.push(SlopFinding {
                line: idx + 1,
                kind: SlopKind::EmptyStub,
                snippet: t.chars().take(80).collect(),
            });
        }
    }
    SlopScanReport {
        clean: findings.is_empty(),
        findings,
    }
}

fn strip_double_quoted_literals(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_str = false;
    let mut escaped = false;
    for ch in line.chars() {
        if in_str {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_str = false;
            }
        } else if ch == '"' {
            in_str = true;
        } else {
            out.push(ch);
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptOutcome {
    Passed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptTurn {
    pub turn_index: u32,
    pub outcome: AttemptOutcome,
    pub summary: String,
}

/// Compact dead-end failed retry attempts while preserving the latest passing/active turns.
#[must_use]
pub fn prune_failed_attempts(turns: &[AttemptTurn], keep_last_failures: usize) -> Vec<AttemptTurn> {
    let mut out = Vec::with_capacity(turns.len());
    let mut trailing_failures = Vec::new();
    for t in turns {
        match t.outcome {
            AttemptOutcome::Passed => {
                trailing_failures.clear();
                out.push(t.clone());
            }
            AttemptOutcome::Failed => trailing_failures.push(t.clone()),
        }
    }
    if trailing_failures.len() > keep_last_failures {
        let drop_n = trailing_failures.len() - keep_last_failures;
        trailing_failures.drain(0..drop_n);
    }
    out.extend(trailing_failures);
    out
}

/// Opt-in Test-Time Scaling configuration (always OFF by default to keep normal latency fast).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestTimeScalingConfig {
    pub enabled: bool,
    pub max_concurrency: usize,
    pub generator_model: String,
    pub verifier_model: String,
    pub require_distinct_verifier_model: bool,
}

impl Default for TestTimeScalingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            max_concurrency: 4,
            generator_model: "primary".to_owned(),
            verifier_model: "cross-verifier".to_owned(),
            require_distinct_verifier_model: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BestOfNCandidateOutcome {
    pub candidate_idx: usize,
    pub passed: bool,
    pub score: f64,
    pub patch_bytes: usize,
    pub summary: String,
    pub receipt: ExecutionReceipt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BestOfNResult {
    pub winner_idx: Option<usize>,
    pub applied_to_repo: bool,
    pub candidates: Vec<BestOfNCandidateOutcome>,
}

/// TEX ($K \times K$ Execution Cross-Validation) matrix + cross-model verifier gate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TexMatrixCell {
    pub patch_idx: usize,
    pub test_idx: usize,
    pub passed: bool,
    pub exit_code: i32,
    pub receipt: ExecutionReceipt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TexCandidateScore {
    pub patch_idx: usize,
    pub tests_passed: usize,
    pub total_tests: usize,
    pub patch_bytes: usize,
    pub slop_findings: usize,
    pub composite_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TexVerifierDecision {
    pub verifier_model: String,
    pub approved: bool,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TexCrossValidationReport {
    pub k: usize,
    pub winner_patch_idx: Option<usize>,
    pub applied_to_repo: bool,
    pub matrix: Vec<TexMatrixCell>,
    pub candidate_scores: Vec<TexCandidateScore>,
    pub verifier_decision: Option<TexVerifierDecision>,
}

/// MCTS node backed by BLAKE3+Deflate `TurnCheckpointStore` rollback snapshots.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MctsNode {
    pub node_id: usize,
    pub parent_id: Option<usize>,
    pub turn_idx: u32,
    pub action_label: String,
    pub visits: u32,
    pub value_sum: f64,
    pub rolled_back: bool,
    pub transition: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MctsSearchReport {
    pub best_node_id: usize,
    pub best_action: String,
    pub best_avg_reward: f64,
    pub nodes: Vec<MctsNode>,
    pub rollback_count: usize,
}

pub type WorktreeActionFuture = Pin<Box<dyn Future<Output = Result<(bool, f64, String)>> + Send>>;
pub type TexSuiteGenFuture = Pin<Box<dyn Future<Output = Result<Vec<(String, String)>>> + Send>>;
pub type TexExecFuture = Pin<Box<dyn Future<Output = Result<(i32, Vec<u8>, Vec<u8>)>> + Send>>;
pub type TexVerifyFuture = Pin<Box<dyn Future<Output = Result<(bool, String)>> + Send>>;
pub type MctsStepFuture = Pin<Box<dyn Future<Output = Result<(f64, String, Vec<(String, String)>)>> + Send>>;

/// Execute opt-in parallel Best-of-N across isolated external Git worktrees.
pub async fn run_best_of_n<F>(
    cfg: &TestTimeScalingConfig,
    repo_root: &Path,
    worktree_base_dir: Option<PathBuf>,
    n: usize,
    apply_winner: bool,
    worker_fn: Arc<F>,
) -> Result<BestOfNResult>
where
    F: Fn(usize, PathBuf) -> WorktreeActionFuture + Send + Sync + 'static,
{
    if !cfg.enabled {
        bail!("test-time scaling Best-of-N is opt-in and currently disabled");
    }
    let mgr = Arc::new(WorktreeManager::new(WorktreeIsolationConfig {
        base_dir: worktree_base_dir
            .unwrap_or_else(|| WorktreeIsolationConfig::default().base_dir),
    }));
    let baseline = mgr.capture_baseline(repo_root)?;
    let count = n.clamp(1, 16);
    let sem = Arc::new(Semaphore::new(cfg.max_concurrency.clamp(1, 8)));

    let mut handles: Vec<(usize, WorktreeHandle)> = Vec::with_capacity(count);
    let mut join_handles = Vec::with_capacity(count);
    for idx in 0..count {
        let wt = mgr.create_worktree(&format!("bon-{idx}"), &baseline)?;
        handles.push((idx, wt.clone()));
        let permit = sem.clone().acquire_owned().await?;
        let mgr_c = Arc::clone(&mgr);
        let wf = Arc::clone(&worker_fn);
        join_handles.push(tokio::spawn(async move {
            let _p = permit;
            let res = wf(idx, wt.worktree_path.clone()).await;
            let (passed, score, summary) = match res {
                Ok(v) => v,
                Err(e) => (false, 0.0, e.to_string()),
            };
            let (patch, _) = mgr_c.capture_delta_patch(&wt).unwrap_or_default();
            let receipt = sign_execution_receipt(
                b"omnia-tts-bon-key",
                &format!("best_of_n_{idx}"),
                if passed { 0 } else { 1 },
                summary.as_bytes(),
                b"",
                idx as i64,
            );
            BestOfNCandidateOutcome {
                candidate_idx: idx,
                passed,
                score,
                patch_bytes: patch.len(),
                summary: SecretRedactor::redact(&summary),
                receipt,
            }
        }));
    }

    let mut outcomes = Vec::with_capacity(count);
    for j in join_handles {
        outcomes.push(j.await?);
    }

    outcomes.sort_by(|a, b| {
        b.passed
            .cmp(&a.passed)
            .then_with(|| b.score.total_cmp(&a.score))
            .then_with(|| a.patch_bytes.cmp(&b.patch_bytes))
            .then_with(|| a.candidate_idx.cmp(&b.candidate_idx))
    });
    let winner_idx = outcomes.first().filter(|c| c.passed).map(|c| c.candidate_idx);
    let mut applied_to_repo = false;
    if apply_winner {
        if let Some(w_idx) = winner_idx {
            if let Some((_, wt)) = handles.iter().find(|(i, _)| *i == w_idx) {
                let merge = mgr.apply_delta_serialized(wt, None).await?;
                applied_to_repo = merge.applied;
            }
        }
    }
    for (_, wt) in handles {
        let _ = mgr.cleanup(&wt);
    }
    Ok(BestOfNResult {
        winner_idx,
        applied_to_repo,
        candidates: outcomes,
    })
}

/// Execute opt-in **TEX $K \times K$ Execution Cross-Validation**:
/// generates $K$ candidate patches + $K$ verification test suites in isolated worktrees,
/// executes the $K \times K$ matrix, ranks by cross-validation + slop cleanliness, and requires
/// an independent cross-model verifier (`verifier_model != generator_model`) before merge.
#[allow(clippy::too_many_arguments)]
pub async fn run_tex_cross_validation<P, T, E, V>(
    cfg: &TestTimeScalingConfig,
    repo_root: &Path,
    worktree_base_dir: Option<PathBuf>,
    k: usize,
    apply_winner: bool,
    patch_gen: Arc<P>,
    test_gen: Arc<T>,
    exec_suite: Arc<E>,
    cross_verifier: Arc<V>,
) -> Result<TexCrossValidationReport>
where
    P: Fn(usize, PathBuf) -> WorktreeActionFuture + Send + Sync + 'static,
    T: Fn(usize, PathBuf) -> TexSuiteGenFuture + Send + Sync + 'static,
    E: Fn(PathBuf, Vec<(String, String)>) -> TexExecFuture + Send + Sync + 'static,
    V: Fn(String, usize, String) -> TexVerifyFuture + Send + Sync + 'static,
{
    if !cfg.enabled {
        bail!("test-time scaling TEX is opt-in and currently disabled");
    }
    if cfg.require_distinct_verifier_model
        && cfg.verifier_model.eq_ignore_ascii_case(&cfg.generator_model)
    {
        bail!(
            "TEX cross-model verifier ({}) must be distinct from patch generator ({})",
            cfg.verifier_model,
            cfg.generator_model
        );
    }
    let k = k.clamp(2, 8);
    let mgr = Arc::new(WorktreeManager::new(WorktreeIsolationConfig {
        base_dir: worktree_base_dir
            .unwrap_or_else(|| WorktreeIsolationConfig::default().base_dir),
    }));
    let baseline = mgr.capture_baseline(repo_root)?;
    let sem = Arc::new(Semaphore::new(cfg.max_concurrency.clamp(1, 8)));

    // 1. Spawn K patch generators + K test-suite generators in parallel external worktrees
    let mut patch_wts = Vec::with_capacity(k);
    let mut patch_tasks = Vec::with_capacity(k);
    for i in 0..k {
        let wt = mgr.create_worktree(&format!("tex-patch-{i}"), &baseline)?;
        patch_wts.push(wt.clone());
        let permit = sem.clone().acquire_owned().await?;
        let pg = Arc::clone(&patch_gen);
        let wp = wt.worktree_path.clone();
        patch_tasks.push(tokio::spawn(async move {
            let _p = permit;
            pg(i, wp).await
        }));
    }

    let mut test_wts = Vec::with_capacity(k);
    let mut test_tasks = Vec::with_capacity(k);
    for j in 0..k {
        let wt = mgr.create_worktree(&format!("tex-test-{j}"), &baseline)?;
        test_wts.push(wt.clone());
        let permit = sem.clone().acquire_owned().await?;
        let tg = Arc::clone(&test_gen);
        let wp = wt.worktree_path.clone();
        test_tasks.push(tokio::spawn(async move {
            let _p = permit;
            tg(j, wp).await
        }));
    }

    for pt in patch_tasks {
        let _ = pt.await?;
    }
    let mut test_suites: Vec<Vec<(String, String)>> = Vec::with_capacity(k);
    for tt in test_tasks {
        let files = tt.await?.unwrap_or_default();
        test_suites.push(files);
    }
    for twt in test_wts {
        let _ = mgr.cleanup(&twt);
    }

    // 2. Execute K x K execution matrix (every test suite T_j on every candidate worktree P_i)
    let mut matrix = Vec::with_capacity(k * k);
    let mut matrix_tasks = Vec::with_capacity(k * k);
    for i in 0..k {
        for j in 0..k {
            let wt_dir = patch_wts[i].worktree_path.clone();
            let suite = test_suites[j].clone();
            let ex = Arc::clone(&exec_suite);
            let permit = sem.clone().acquire_owned().await?;
            matrix_tasks.push(tokio::spawn(async move {
                let _p = permit;
                let (code, stdout, stderr) = ex(wt_dir, suite).await.unwrap_or((-1, Vec::new(), Vec::new()));
                let receipt = sign_execution_receipt(
                    b"omnia-tex-matrix-key",
                    &format!("tex_p{i}_t{j}"),
                    code,
                    &stdout,
                    &stderr,
                    (i * k + j) as i64,
                );
                TexMatrixCell {
                    patch_idx: i,
                    test_idx: j,
                    passed: code == 0,
                    exit_code: code,
                    receipt,
                }
            }));
        }
    }
    for mt in matrix_tasks {
        matrix.push(mt.await?);
    }

    // 3. Score every candidate patch i by cross-validation pass rate, slop cleanliness, and minimal diff
    let mut candidate_scores = Vec::with_capacity(k);
    for (i, wt) in patch_wts.iter().enumerate() {
        let passed_count = matrix
            .iter()
            .filter(|c| c.patch_idx == i && c.passed)
            .count();
        let (delta, touched) = mgr.capture_delta_patch(wt).unwrap_or_default();
        let mut slop_findings = 0usize;
        for rel in &touched {
            if rel.ends_with(".rs") {
                if let Ok(src) = std::fs::read_to_string(wt.worktree_path.join(rel)) {
                    slop_findings += scan_source_for_slop(&src, SlopLanguage::Rust)
                        .findings
                        .len();
                }
            }
        }
        let pass_ratio = passed_count as f64 / k as f64;
        let penalty = (slop_findings as f64 * 0.25) + (delta.len() as f64 / 100_000.0);
        candidate_scores.push(TexCandidateScore {
            patch_idx: i,
            tests_passed: passed_count,
            total_tests: k,
            patch_bytes: delta.len(),
            slop_findings,
            composite_score: (pass_ratio - penalty).max(0.0),
        });
    }
    candidate_scores.sort_by(|a, b| {
        b.tests_passed
            .cmp(&a.tests_passed)
            .then_with(|| a.slop_findings.cmp(&b.slop_findings))
            .then_with(|| b.composite_score.total_cmp(&a.composite_score))
            .then_with(|| a.patch_bytes.cmp(&b.patch_bytes))
    });

    let top = candidate_scores.first().filter(|c| c.tests_passed > 0).map(|c| c.patch_idx);
    let mut verifier_decision = None;
    let mut winner_patch_idx = None;
    let mut applied_to_repo = false;

    if let Some(best_idx) = top {
        let matrix_summary = json!({
            "patch_idx": best_idx,
            "scores": &candidate_scores,
            "cells": matrix.iter().map(|c| json!({
                "p": c.patch_idx,
                "t": c.test_idx,
                "passed": c.passed,
                "exit": c.exit_code,
            })).collect::<Vec<_>>(),
        })
        .to_string();
        let (approved, rationale) = cross_verifier(
            cfg.verifier_model.clone(),
            best_idx,
            matrix_summary,
        )
        .await?;
        verifier_decision = Some(TexVerifierDecision {
            verifier_model: cfg.verifier_model.clone(),
            approved,
            rationale: SecretRedactor::redact(&rationale),
        });
        if approved {
            winner_patch_idx = Some(best_idx);
            if apply_winner {
                let merge = mgr.apply_delta_serialized(&patch_wts[best_idx], None).await?;
                applied_to_repo = merge.applied;
            }
        }
    }

    for wt in patch_wts {
        let _ = mgr.cleanup(&wt);
    }

    Ok(TexCrossValidationReport {
        k,
        winner_patch_idx,
        applied_to_repo,
        matrix,
        candidate_scores,
        verifier_decision,
    })
}

/// Parallel-Distill-Refine (PDR) synthesis of a TEX $K \times K$ matrix: distills
/// execution receipts and failure invariants into a compact, secret-redacted digest
/// without leaking multi-kilobyte raw logs into follow-up refinement prompts.
#[must_use]
pub fn distill_tex_matrix_pdr(report: &TexCrossValidationReport, max_chars: usize) -> String {
    let mut lines = vec![format!(
        "TEX_PDR k={} winner={:?} applied={}",
        report.k, report.winner_patch_idx, report.applied_to_repo
    )];
    for sc in &report.candidate_scores {
        let failing_tests: Vec<String> = report
            .matrix
            .iter()
            .filter(|c| c.patch_idx == sc.patch_idx && !c.passed)
            .map(|c| format!("T{}(rc={})", c.test_idx, c.exit_code))
            .collect();
        lines.push(format!(
            "- P{}: pass={}/{} diff={}B slop={} score={:.3} fail=[{}]",
            sc.patch_idx,
            sc.tests_passed,
            sc.total_tests,
            sc.patch_bytes,
            sc.slop_findings,
            sc.composite_score,
            failing_tests.join(",")
        ));
    }
    if let Some(ref dec) = report.verifier_decision {
        lines.push(format!(
            "- verifier({}): approved={} note={}",
            dec.verifier_model,
            dec.approved,
            omnia_core::truncate_utf8_word_safe(&dec.rationale, 160)
        ));
    }
    omnia_core::truncate_utf8_word_safe(&SecretRedactor::redact(&lines.join("\n")), max_chars.max(128))
}

/// Deferred tool schema (`test_scale_run`) for opt-in Best-of-N / TEX KxK / MCTS evaluation.
#[must_use]
pub fn test_time_scaling_tool_specs() -> Vec<crate::plugin::ToolSpec> {
    vec![crate::plugin::ToolSpec {
        name: "test_scale_run".into(),
        description: "Opt-in Test-Time Scaling status, slop check, and ExecutionReceipt signing/verification.".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "mode": { "type": "string", "enum": ["status", "slop_scan", "verify_receipt"] },
                "enabled": { "type": "boolean" },
                "language": { "type": "string", "enum": ["rust", "python", "typescript"] },
                "source": { "type": "string" }
            },
            "required": ["mode"],
            "additionalProperties": false
        }),
        read_only: true,
    }]
}

/// Runtime helper executing deterministic Test-Time Scaling diagnostics or gating checks.
pub fn dispatch_test_scale_tool_json(
    cfg: &TestTimeScalingConfig,
    args: &Value,
) -> Result<String> {
    let mode = args
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("status");
    match mode {
        "status" => Ok(serde_json::to_string_pretty(cfg)?),
        "slop_scan" => {
            let lang = match args.get("language").and_then(Value::as_str).unwrap_or("rust") {
                "python" => SlopLanguage::Python,
                "typescript" => SlopLanguage::TypeScript,
                _ => SlopLanguage::Rust,
            };
            let src = args.get("source").and_then(Value::as_str).unwrap_or("");
            Ok(serde_json::to_string_pretty(&scan_source_for_slop(src, lang))?)
        }
        other => bail!("unsupported test_scale_run mode '{other}'"),
    }
}

/// MCTS UCT tree search + deterministic BLAKE3+Deflate `TurnCheckpointStore` rollback on regression.
pub async fn run_mcts_tree_search<S>(
    cfg: &TestTimeScalingConfig,
    workspace_root: &Path,
    actions: &[String],
    rollouts: usize,
    exploration_c: f64,
    step_executor: Arc<S>,
) -> Result<MctsSearchReport>
where
    S: Fn(String, u32) -> MctsStepFuture + Send + Sync + 'static,
{
    if !cfg.enabled {
        bail!("test-time scaling MCTS is opt-in and currently disabled");
    }
    if actions.is_empty() {
        bail!("MCTS requires at least one candidate action");
    }

    let mut checkpoints = TurnCheckpointStore::new("mcts-session", None);
    let mut nodes = vec![MctsNode {
        node_id: 0,
        parent_id: None,
        turn_idx: 0,
        action_label: "root".to_owned(),
        visits: 1,
        value_sum: 0.0,
        rolled_back: false,
        transition: "Baseline".to_owned(),
    }];
    let mut rollback_count = 0usize;
    let total_rollouts = rollouts.clamp(1, 32);

    for step_idx in 0..total_rollouts {
        let turn_idx = (step_idx as u32) + 1;
        // UCT selection among existing nodes (prefer unexplored actions from root or best UCT leaf)
        let action = actions[step_idx % actions.len()].clone();
        let parent_id = if nodes.len() == 1 {
            0
        } else {
            let parent_visits = nodes[0].visits as f64;
            nodes
                .iter()
                .filter(|n| !n.rolled_back)
                .max_by(|a, b| {
                    let uct_a = (a.value_sum / (a.visits.max(1) as f64))
                        + exploration_c * ((parent_visits.ln() / (a.visits.max(1) as f64)).sqrt());
                    let uct_b = (b.value_sum / (b.visits.max(1) as f64))
                        + exploration_c * ((parent_visits.ln() / (b.visits.max(1) as f64)).sqrt());
                    uct_a.total_cmp(&uct_b)
                })
                .map(|n| n.node_id)
                .unwrap_or(0)
        };

        // Snapshot candidate files pre-mutation into BLAKE3+Deflate checkpoint store
        let (reward, test_output, modified_files) = step_executor(action.clone(), turn_idx).await?;
        for (rel, pre_bytes) in &modified_files {
            let abs = workspace_root.join(rel);
            let exists_pre = abs.exists();
            if !exists_pre {
                checkpoints.record_pre_mutation(turn_idx, rel, &abs);
            } else {
                let _ = pre_bytes;
                checkpoints.record_pre_mutation(turn_idx, rel, &abs);
            }
        }
        let tracker = FileReadTracker::new();
        let transition = checkpoints.record_test_outcome_detailed(turn_idx, &test_output);
        let mut rolled_back = false;
        let trans_label = match transition {
            TestOutcomeTransition::Regression(_) => {
                let _ = checkpoints.rollback_to_turn(
                    turn_idx.saturating_sub(1),
                    workspace_root,
                    &tracker,
                );
                rolled_back = true;
                rollback_count += 1;
                "Regression"
            }
            TestOutcomeTransition::FailToPass { .. } => "FailToPass",
            TestOutcomeTransition::AllGreen { .. } => "AllGreen",
            TestOutcomeTransition::Neutral => "Neutral",
        };

        let node_id = nodes.len();
        let effective_reward = if rolled_back { reward.min(0.0) } else { reward };
        nodes.push(MctsNode {
            node_id,
            parent_id: Some(parent_id),
            turn_idx,
            action_label: action,
            visits: 1,
            value_sum: effective_reward,
            rolled_back,
            transition: trans_label.to_owned(),
        });

        // Backpropagate reward up ancestors
        let mut cur = Some(parent_id);
        let mut hop_guard = 0usize;
        while let Some(pid) = cur {
            if hop_guard > nodes.len() {
                break;
            }
            hop_guard += 1;
            nodes[pid].visits += 1;
            nodes[pid].value_sum += effective_reward;
            cur = nodes[pid].parent_id;
        }
    }

    let best = nodes
        .iter()
        .skip(1)
        .filter(|n| !n.rolled_back)
        .max_by(|a, b| {
            let avg_a = a.value_sum / (a.visits.max(1) as f64);
            let avg_b = b.value_sum / (b.visits.max(1) as f64);
            avg_a.total_cmp(&avg_b)
        })
        .unwrap_or(&nodes[0]);

    Ok(MctsSearchReport {
        best_node_id: best.node_id,
        best_action: best.action_label.clone(),
        best_avg_reward: best.value_sum / (best.visits.max(1) as f64),
        nodes,
        rollback_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_forensics::run_git;
    use uuid::Uuid;

    #[test]
    fn hmac_receipt_and_slop_scanner_and_attempt_pruning_work() {
        let key = b"test-hmac-key";
        let rec = sign_execution_receipt(key, "cargo test --locked", 0, b"ok", b"", 1_000);
        assert!(verify_execution_receipt(key, &rec));
        assert!(!verify_execution_receipt(b"wrong-key", &rec));

        let rep = scan_source_for_slop("pub fn f() { todo!(); }\n", SlopLanguage::Rust);
        assert!(!rep.clean);
        assert_eq!(rep.findings[0].kind, SlopKind::TodoMacro);

        let pruned = prune_failed_attempts(
            &[
                AttemptTurn { turn_index: 1, outcome: AttemptOutcome::Failed, summary: "err1".into() },
                AttemptTurn { turn_index: 2, outcome: AttemptOutcome::Failed, summary: "err2".into() },
                AttemptTurn { turn_index: 3, outcome: AttemptOutcome::Failed, summary: "err3".into() },
                AttemptTurn { turn_index: 4, outcome: AttemptOutcome::Passed, summary: "pass".into() },
            ],
            1,
        );
        assert_eq!(pruned.len(), 1);
        assert_eq!(pruned[0].turn_index, 4);
    }

    #[tokio::test]
    async fn tex_kxk_execution_cross_validation_and_cross_model_verifier() {
        let tmp_root = std::env::temp_dir().join(format!("omnia-tex-{}", Uuid::new_v4().simple()));
        let repo = tmp_root.join("repo");
        let wt_base = tmp_root.join("wt");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init"]).unwrap();
        run_git(&repo, &["config", "user.name", "omnia-test"]).unwrap();
        run_git(&repo, &["config", "user.email", "omnia-test@example.test"]).unwrap();
        std::fs::write(repo.join("calc.py"), "def add(a, b):\n    return a - b\n").unwrap();
        run_git(&repo, &["add", "calc.py"]).unwrap();
        run_git(&repo, &["commit", "-m", "buggy calc"]).unwrap();

        let cfg = TestTimeScalingConfig {
            enabled: true,
            max_concurrency: 2,
            generator_model: "gpt-author".to_owned(),
            verifier_model: "claude-verifier".to_owned(),
            require_distinct_verifier_model: true,
        };

        let patch_gen = Arc::new(|idx: usize, wt: PathBuf| -> WorktreeActionFuture {
            Box::pin(async move {
                if idx == 1 {
                    std::fs::write(wt.join("calc.py"), "def add(a, b):\n    return a + b\n")?;
                } else {
                    std::fs::write(wt.join("calc.py"), "def add(a, b):\n    return a * b\n")?;
                }
                Ok((true, 1.0, format!("patch {idx}")))
            })
        });

        let test_gen = Arc::new(|idx: usize, _wt: PathBuf| -> TexSuiteGenFuture {
            Box::pin(async move {
                Ok(vec![(format!("test_{idx}.py"), "assert add(2, 3) == 5".to_owned())])
            })
        });

        let exec_suite = Arc::new(
            |wt: PathBuf, _suite: Vec<(String, String)>| -> TexExecFuture {
                Box::pin(async move {
                    let src = std::fs::read_to_string(wt.join("calc.py")).unwrap_or_default();
                    if src.contains("a + b") {
                        Ok((0, b"1 passed".to_vec(), Vec::new()))
                    } else {
                        Ok((1, Vec::new(), b"AssertionError".to_vec()))
                    }
                })
            },
        );

        let verifier = Arc::new(
            |_model: String, patch_idx: usize, _matrix_json: String| -> TexVerifyFuture {
                Box::pin(async move { Ok((patch_idx == 1, "Cross-model check passed".to_owned())) })
            },
        );

        let report = run_tex_cross_validation(
            &cfg,
            &repo,
            Some(wt_base),
            2,
            true,
            patch_gen,
            test_gen,
            exec_suite,
            verifier,
        )
        .await
        .expect("tex report");

        assert_eq!(report.matrix.len(), 4);
        assert_eq!(report.winner_patch_idx, Some(1));
        assert!(report.applied_to_repo);
        assert!(std::fs::read_to_string(repo.join("calc.py"))
            .unwrap()
            .contains("a + b"));
        let pdr = distill_tex_matrix_pdr(&report, 600);
        assert!(pdr.contains("TEX_PDR k=2 winner=Some(1)"));
        assert!(pdr.contains("pass=2/2"));

        let _ = std::fs::remove_dir_all(&tmp_root);
    }

    #[tokio::test]
    async fn mcts_tree_search_rolls_back_on_regression() {
        let tmp_root = std::env::temp_dir().join(format!("omnia-mcts-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&tmp_root).unwrap();
        std::fs::write(tmp_root.join("app.py"), "x = 1\n").unwrap();
        let cfg = TestTimeScalingConfig {
            enabled: true,
            ..Default::default()
        };
        let ws = tmp_root.clone();
        let exec = Arc::new(move |action: String, turn_idx: u32| -> MctsStepFuture {
            let root = ws.clone();
            Box::pin(async move {
                if turn_idx == 1 {
                    Ok((1.0, "3 passed, 0 failed".to_owned(), vec![]))
                } else {
                    let pre = std::fs::read_to_string(root.join("app.py")).unwrap_or_default();
                    let out = if action == "risky" {
                        "1 passed, 2 failed".to_owned()
                    } else {
                        "3 passed, 0 failed".to_owned()
                    };
                    Ok((0.1, out, vec![("app.py".to_owned(), pre)]))
                }
            })
        });
        let rep = run_mcts_tree_search(
            &cfg,
            &tmp_root,
            &["safe".to_owned(), "risky".to_owned()],
            2,
            1.4,
            exec,
        )
        .await
        .expect("mcts");
        assert_eq!(rep.rollback_count, 1);
        assert_eq!(rep.best_action, "safe");
        let _ = std::fs::remove_dir_all(&tmp_root);
    }
}
