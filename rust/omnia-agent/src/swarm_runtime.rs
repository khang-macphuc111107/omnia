use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use omnia_core::SecretRedactor;
use omnia_graph::{
    AgentGraphError, AgentNode, AgentRole, ConvergenceReport, PeerLinkEdge, PeerMeshGraph,
    PeerMessage, StalledPeerAlert,
};
use omnia_harness::{MemoryKind, MemoryProvenance, MemoryScope, MemoryTier};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{Notify, Semaphore};
use uuid::Uuid;

use crate::agent_store::default_omnia_data_dir;
use crate::git_forensics::{probe_git_head_oid, run_git, run_git_bytes, run_git_with_stdin};
use crate::memory_engine::{MemoryEngine, RetainItemInput};
use crate::path_guard::sanitize_windows_path;
use crate::sap_json::repair_tool_json;

const MAX_BASELINE_PATCH_BYTES: usize = 2 * 1024 * 1024;
pub const AUTO_PARALLEL_COUPLED_AT: f64 = 0.35;
pub const AUTO_PARALLEL_MAX_ITEMS: usize = 16;
pub const DEFAULT_ADVISOR_MAX_EMISSIONS: usize = 12;

/// Isolated external Git worktree configuration (`D:\OmniaData\worktrees\` by default,
/// never nested inside tracked source checkouts).
#[derive(Debug, Clone)]
pub struct WorktreeIsolationConfig {
    pub base_dir: PathBuf,
}

impl Default for WorktreeIsolationConfig {
    fn default() -> Self {
        Self {
            base_dir: default_omnia_data_dir().join("worktrees"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeBaseline {
    pub repo_root: PathBuf,
    pub head_commit: String,
    pub staged_patch: Vec<u8>,
    pub unstaged_patch: Vec<u8>,
    pub untracked_files: Vec<(String, Vec<u8>)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeHandle {
    pub id: String,
    pub repo_root: PathBuf,
    pub worktree_path: PathBuf,
    pub branch: String,
    pub head_commit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeMergeOutcome {
    pub applied: bool,
    pub touched_files: Vec<String>,
    pub patch_bytes: usize,
    pub rescue_patch_path: Option<PathBuf>,
    pub message: String,
}

/// Manages isolated external Git worktrees using `--no-optional-locks`, Windows
/// `FILE_ATTRIBUTE_REPARSE_POINT (0x400)` safety guards, and serialized 3-way merge-back.
pub struct WorktreeManager {
    config: WorktreeIsolationConfig,
    merge_locks: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

impl Default for WorktreeManager {
    fn default() -> Self {
        Self::new(WorktreeIsolationConfig::default())
    }
}

impl WorktreeManager {
    #[must_use]
    pub fn new(config: WorktreeIsolationConfig) -> Self {
        Self {
            config,
            merge_locks: Mutex::new(HashMap::new()),
        }
    }

    #[must_use]
    pub fn base_dir(&self) -> &Path {
        &self.config.base_dir
    }

    fn merge_lock_for(&self, repo_root: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let key = sanitize_windows_path(repo_root);
        let mut guard = self.merge_locks.lock().unwrap();
        guard
            .entry(key)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// Capture committed HEAD + uncommitted staged/unstaged/untracked baseline state
    /// without touching nested repositories or reparse points.
    pub fn capture_baseline(&self, repo_root: &Path) -> Result<WorktreeBaseline> {
        let clean_root = sanitize_windows_path(repo_root);
        let head_commit = probe_git_head_oid(&clean_root)
            .or_else(|| run_git(&clean_root, &["rev-parse", "HEAD"]).ok().map(|s| s.trim().to_owned()))
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("repository {} has no HEAD commit", clean_root.display()))?;

        let staged_patch = run_git_bytes(&clean_root, &["diff", "--cached", "--binary"])?;
        if staged_patch.len() > MAX_BASELINE_PATCH_BYTES {
            bail!("staged baseline diff exceeds 2 MiB isolation budget");
        }
        let unstaged_patch = run_git_bytes(&clean_root, &["diff", "--binary"])?;
        if unstaged_patch.len() > MAX_BASELINE_PATCH_BYTES {
            bail!("unstaged baseline diff exceeds 2 MiB isolation budget");
        }

        let untracked_raw = run_git(
            &clean_root,
            &["ls-files", "--others", "--exclude-standard", "-z"],
        )?;
        let mut untracked_files = Vec::new();
        let mut total_untracked_bytes = 0usize;
        for rel in untracked_raw.split('\0').filter(|s| !s.is_empty()) {
            let clean_rel = rel.replace('\\', "/");
            if clean_rel.starts_with("../") || clean_rel.contains("/../") {
                continue;
            }
            let full = clean_root.join(&clean_rel);
            let Ok(meta) = fs::symlink_metadata(&full) else {
                continue;
            };
            if is_reparse_or_symlink(&meta) || !meta.is_file() {
                continue;
            }
            let bytes = fs::read(&full)?;
            total_untracked_bytes = total_untracked_bytes.saturating_add(bytes.len());
            if total_untracked_bytes > MAX_BASELINE_PATCH_BYTES {
                bail!("untracked baseline files exceed 2 MiB isolation budget");
            }
            untracked_files.push((clean_rel, bytes));
        }

        Ok(WorktreeBaseline {
            repo_root: clean_root,
            head_commit,
            staged_patch,
            unstaged_patch,
            untracked_files,
        })
    }

    /// Materialize an isolated external worktree under `D:\OmniaData\worktrees\<slug>-<id>`
    /// at the exact `baseline.head_commit` + uncommitted working snapshot.
    pub fn create_worktree(&self, slug: &str, baseline: &WorktreeBaseline) -> Result<WorktreeHandle> {
        let safe_slug: String = slug
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect();
        let id = Uuid::new_v4().simple().to_string()[..10].to_owned();
        let dir_name = format!("{}-{id}", safe_slug.trim_matches('-'));
        let branch = format!("omnia/wt-{dir_name}");
        fs::create_dir_all(&self.config.base_dir)?;
        let canon_base = fs::canonicalize(&self.config.base_dir)?;
        let wt_path = canon_base.join(&dir_name);
        if wt_path.exists() {
            let _ = fs::remove_dir_all(&wt_path);
        }
        let wt_str = sanitize_windows_path(&wt_path)
            .to_string_lossy()
            .into_owned();

        run_git(
            &baseline.repo_root,
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                &wt_str,
                &baseline.head_commit,
            ],
        )
        .with_context(|| format!("failed creating isolated worktree at {wt_str}"))?;

        if !baseline.staged_patch.is_empty() {
            run_git_with_stdin(&wt_path, &["apply", "--index", "--binary"], &baseline.staged_patch)
                .with_context(|| "failed hydrating staged baseline into worktree")?;
        }
        if !baseline.unstaged_patch.is_empty() {
            run_git_with_stdin(&wt_path, &["apply", "--binary"], &baseline.unstaged_patch)
                .with_context(|| "failed hydrating unstaged baseline into worktree")?;
        }
        for (rel, bytes) in &baseline.untracked_files {
            let dest = wt_path.join(rel);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&dest, bytes)?;
        }

        // Snapshot baseline inside worktree as initial commit on branch `omnia/wt-*` so
        // `git diff HEAD` cleanly isolates only worker-made edits!
        run_git(&wt_path, &["add", "-A"])?;
        let status = run_git(&wt_path, &["status", "--porcelain"])?;
        if !status.trim().is_empty() {
            run_git(
                &wt_path,
                &[
                    "-c",
                    "user.name=omnia-swarm",
                    "-c",
                    "user.email=omnia-swarm@localhost.invalid",
                    "commit",
                    "--no-verify",
                    "-m",
                    "omnia: isolate working baseline",
                ],
            )?;
        }
        let wt_baseline_oid = run_git(&wt_path, &["rev-parse", "HEAD"])?
            .trim()
            .to_owned();

        Ok(WorktreeHandle {
            id,
            repo_root: baseline.repo_root.clone(),
            worktree_path: wt_path,
            branch,
            head_commit: wt_baseline_oid,
        })
    }

    /// Capture only the delta introduced inside `handle.worktree_path` relative to its baseline commit.
    pub fn capture_delta_patch(&self, handle: &WorktreeHandle) -> Result<(Vec<u8>, Vec<String>)> {
        run_git(&handle.worktree_path, &["add", "-A"])?;
        let patch = run_git_bytes(
            &handle.worktree_path,
            &["diff", "--cached", "--binary", &handle.head_commit],
        )?;
        let names_raw = run_git(
            &handle.worktree_path,
            &["diff", "--cached", "--name-only", &handle.head_commit],
        )?;
        let touched = names_raw
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        Ok((patch, touched))
    }

    /// Apply a captured delta patch back onto `repo_root` under a per-repo async mutex,
    /// enforcing disjoint path verification before application.
    pub async fn apply_delta_serialized(
        &self,
        handle: &WorktreeHandle,
        allowed_paths: Option<&[String]>,
    ) -> Result<WorktreeMergeOutcome> {
        let (patch, touched) = self.capture_delta_patch(handle)?;
        if patch.is_empty() {
            return Ok(WorktreeMergeOutcome {
                applied: true,
                touched_files: Vec::new(),
                patch_bytes: 0,
                rescue_patch_path: None,
                message: "no changes produced by worker".to_owned(),
            });
        }

        if let Some(allow) = allowed_paths {
            for rel in &touched {
                let norm = omnia_graph::normalize_repo_path(rel);
                if !allow
                    .iter()
                    .any(|p| omnia_graph::prefix_covers(p, &norm))
                {
                    bail!(
                        "disjoint_paths violation: worker in {} modified unowned path '{}'",
                        handle.id,
                        norm
                    );
                }
            }
        }

        let lock = self.merge_lock_for(&handle.repo_root);
        let _guard = lock.lock().await;
        match run_git_with_stdin(&handle.repo_root, &["apply", "--3way", "--binary"], &patch) {
            Ok(_) => Ok(WorktreeMergeOutcome {
                applied: true,
                touched_files: touched,
                patch_bytes: patch.len(),
                rescue_patch_path: None,
                message: "patch applied cleanly via 3-way merge".to_owned(),
            }),
            Err(err) => {
                let rescue_dir = self.config.base_dir.join("rescue");
                fs::create_dir_all(&rescue_dir)?;
                let rescue_path = rescue_dir.join(format!("{}.patch", handle.id));
                fs::write(&rescue_path, &patch)?;
                Ok(WorktreeMergeOutcome {
                    applied: false,
                    touched_files: touched,
                    patch_bytes: patch.len(),
                    rescue_patch_path: Some(rescue_path),
                    message: format!("3-way merge conflict rescued to patch file: {err}"),
                })
            }
        }
    }

    /// Safely remove an isolated external worktree & temporary branch after checking
    /// containment strictly within `config.base_dir`.
    pub fn cleanup(&self, handle: &WorktreeHandle) -> Result<()> {
        let canon_base = fs::canonicalize(&self.config.base_dir).unwrap_or_else(|_| self.config.base_dir.clone());
        let wt_str = sanitize_windows_path(&handle.worktree_path)
            .to_string_lossy()
            .into_owned();
        let _ = run_git(&handle.repo_root, &["worktree", "remove", "--force", &wt_str]);
        let _ = run_git(&handle.repo_root, &["worktree", "prune"]);
        let _ = run_git(&handle.repo_root, &["branch", "-D", &handle.branch]);
        if handle.worktree_path.exists() {
            if let Ok(canon_wt) = fs::canonicalize(&handle.worktree_path) {
                if canon_wt.starts_with(&canon_base) {
                    if let Ok(meta) = fs::symlink_metadata(&canon_wt) {
                        if !is_reparse_or_symlink(&meta) {
                            let _ = fs::remove_dir_all(&canon_wt);
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

/// Subagent JSON output validator enforcing required keys, field types, enums, and bounds.
pub fn validate_typed_subagent_json(raw_output: &str, schema: &Value) -> Result<Value, String> {
    let repaired = repair_tool_json(raw_output, Some(schema))?;
    validate_json_value(&repaired.value, schema, "$")?;
    Ok(repaired.value)
}

fn validate_json_value(val: &Value, schema: &Value, path: &str) -> Result<(), String> {
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
        if !allowed.iter().any(|candidate| candidate == val) {
            return Err(format!("{path}: value {val} not in allowed enum {allowed:?}"));
        }
    }
    if let Some(expected_type) = schema.get("type").and_then(Value::as_str) {
        let ok = match expected_type {
            "string" => val.is_string(),
            "number" => val.is_number(),
            "integer" => val.as_i64().is_some() || val.as_u64().is_some(),
            "boolean" => val.is_boolean(),
            "array" => val.is_array(),
            "object" => val.is_object(),
            "null" => val.is_null(),
            _ => true,
        };
        if !ok {
            return Err(format!("{path}: expected JSON type '{expected_type}', got {val}"));
        }
    }
    if let (Some(obj), Some(props)) = (
        val.as_object(),
        schema.get("properties").and_then(Value::as_object),
    ) {
        if let Some(req) = schema.get("required").and_then(Value::as_array) {
            for r in req.iter().filter_map(Value::as_str) {
                if !obj.contains_key(r) {
                    return Err(format!("{path}: missing required property '{r}'"));
                }
            }
        }
        for (k, prop_schema) in props {
            if let Some(child) = obj.get(k) {
                validate_json_value(child, prop_schema, &format!("{path}.{k}"))?;
            }
        }
    }
    if let (Some(arr), Some(item_schema)) = (val.as_array(), schema.get("items")) {
        for (i, item) in arr.iter().enumerate() {
            validate_json_value(item, item_schema, &format!("{path}[{i}]"))?;
        }
    }
    Ok(())
}

/// Standard OMP P0-P3 Review schema + strongly-typed outputs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReviewFinding {
    pub title: String,
    pub body: String,
    pub priority: u8,
    pub confidence: f64,
    pub file_path: String,
    pub line_start: u32,
    pub line_end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReviewVerdict {
    pub overall_correctness: String,
    pub explanation: String,
    pub confidence: f64,
    #[serde(default)]
    pub findings: Vec<ReviewFinding>,
}

#[must_use]
pub fn review_output_schema() -> Value {
    json!({
        "type": "object",
        "required": ["overall_correctness", "explanation", "confidence"],
        "properties": {
            "overall_correctness": { "type": "string", "enum": ["correct", "incorrect"] },
            "explanation": { "type": "string" },
            "confidence": { "type": "number" },
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["title", "body", "priority", "confidence", "file_path", "line_start", "line_end"],
                    "properties": {
                        "title": { "type": "string" },
                        "body": { "type": "string" },
                        "priority": { "type": "integer" },
                        "confidence": { "type": "number" },
                        "file_path": { "type": "string" },
                        "line_start": { "type": "integer" },
                        "line_end": { "type": "integer" }
                    }
                }
            }
        }
    })
}

/// Advisor delivery mode & WATCHDOG.yml rule support (`omp-deck` + OMP `advisor`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdvisorSeverity {
    Nit,
    Concern,
    Blocker,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchdogRule {
    pub id: String,
    pub pattern: String,
    pub severity: AdvisorSeverity,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvisoryEmission {
    pub rule_id: String,
    pub severity: AdvisorSeverity,
    pub message: String,
    pub xml_block: String,
}

/// Bounded advisor emission guard (budget `4..=32`, deduplicated, rate-limited).
pub struct AdvisorEmissionGuard {
    max_emissions: usize,
    emitted_count: usize,
    seen_hashes: BTreeSet<String>,
    last_emit_ms: i64,
    min_interval_ms: i64,
    rules: Vec<WatchdogRule>,
}

impl AdvisorEmissionGuard {
    #[must_use]
    pub fn new(max_emissions: usize, min_interval_ms: i64, rules: Vec<WatchdogRule>) -> Self {
        Self {
            max_emissions: max_emissions.clamp(4, 32),
            emitted_count: 0,
            seen_hashes: BTreeSet::new(),
            last_emit_ms: 0,
            min_interval_ms: min_interval_ms.max(0),
            rules,
        }
    }

    /// Parse lightweight `WATCHDOG.yml` rules (`- id: ... pattern: ... severity: ... message: ...`).
    pub fn from_watchdog_yaml(yaml_text: &str) -> Result<Self> {
        let parsed: Value = serde_yaml::from_str(yaml_text)
            .context("failed parsing WATCHDOG.yml advisor rules")?;
        let mut rules = Vec::new();
        if let Some(arr) = parsed
            .get("rules")
            .or(Some(&parsed))
            .and_then(Value::as_array)
        {
            for item in arr {
                let Some(id) = item.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let Some(pattern) = item.get("pattern").and_then(Value::as_str) else {
                    continue;
                };
                let Some(message) = item.get("message").and_then(Value::as_str) else {
                    continue;
                };
                let severity = match item
                    .get("severity")
                    .and_then(Value::as_str)
                    .unwrap_or("concern")
                {
                    "nit" => AdvisorSeverity::Nit,
                    "blocker" => AdvisorSeverity::Blocker,
                    _ => AdvisorSeverity::Concern,
                };
                rules.push(WatchdogRule {
                    id: id.to_owned(),
                    pattern: pattern.to_owned(),
                    severity,
                    message: message.to_owned(),
                });
            }
        }
        Ok(Self::new(DEFAULT_ADVISOR_MAX_EMISSIONS, 5_000, rules))
    }

    pub fn evaluate_and_emit(
        &mut self,
        rule_id: &str,
        severity: AdvisorSeverity,
        raw_message: &str,
        now_ms: i64,
    ) -> Option<AdvisoryEmission> {
        let clean = SecretRedactor::redact(raw_message.trim());
        if clean.is_empty() || self.emitted_count >= self.max_emissions {
            return None;
        }
        if self.last_emit_ms > 0
            && now_ms.saturating_sub(self.last_emit_ms) < self.min_interval_ms
            && severity != AdvisorSeverity::Blocker
        {
            return None;
        }
        let fingerprint = format!("{rule_id}:{clean}");
        if !self.seen_hashes.insert(fingerprint) {
            return None;
        }
        self.emitted_count += 1;
        self.last_emit_ms = now_ms;
        let sev_str = match severity {
            AdvisorSeverity::Nit => "nit",
            AdvisorSeverity::Concern => "concern",
            AdvisorSeverity::Blocker => "blocker",
        };
        let xml_block = format!(
            "<advisory rule=\"{rule_id}\" severity=\"{sev_str}\" guidance=\"weigh, don't blindly obey\" placement=\"message_tail\">{clean}</advisory>"
        );
        Some(AdvisoryEmission {
            rule_id: rule_id.to_owned(),
            severity,
            message: clean,
            xml_block,
        })
    }

    pub fn inspect_watchdog_rules(&mut self, haystack: &str, now_ms: i64) -> Vec<AdvisoryEmission> {
        let low = haystack.to_ascii_lowercase();
        let snapshot = self.rules.clone();
        let mut out = Vec::new();
        for rule in snapshot {
            if !rule.pattern.is_empty() && low.contains(&rule.pattern.to_ascii_lowercase()) {
                if let Some(em) = self.evaluate_and_emit(&rule.id, rule.severity, &rule.message, now_ms) {
                    out.push(em);
                }
            }
        }
        out
    }
}

/// Auto-parallel request segmentation & coupled connected-component planner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParallelPlan {
    pub items: Vec<String>,
    pub context: Vec<usize>,
    pub wrapup: Vec<usize>,
    pub subtasks: Vec<Vec<usize>>,
}

#[must_use]
pub fn segment_request(request: &str) -> Vec<String> {
    let mut items: Vec<(Vec<String>, usize)> = Vec::new();
    let mut fence: Option<String> = None;
    for raw_line in request.lines() {
        let trimmed = raw_line.trim();
        let fence_mark = ["```", "~~~"]
            .into_iter()
            .find(|m| trimmed.starts_with(m));
        if fence.is_some() || fence_mark.is_some() {
            match (&fence, fence_mark) {
                (None, Some(m)) => fence = Some(m.to_owned()),
                (Some(open_m), Some(m)) if m.starts_with(open_m.as_str()) => fence = None,
                _ => {}
            }
            if let Some(last) = items.last_mut() {
                last.0.push(raw_line.to_owned());
            } else {
                items.push((vec![raw_line.to_owned()], usize::MAX));
            }
            continue;
        }
        if trimmed.is_empty() {
            continue;
        }
        let indent = raw_line.len().saturating_sub(raw_line.trim_start().len());
        if let Some(last) = items.last_mut() {
            if indent >= last.1 {
                last.0.push(trimmed.to_owned());
                continue;
            }
        }
        if let Some((after_marker, nest_at)) = strip_list_marker(raw_line) {
            items.push((vec![after_marker.trim().to_owned()], nest_at));
        } else {
            items.push((vec![trimmed.to_owned()], usize::MAX));
        }
    }
    items.into_iter().map(|(lines, _)| lines.join("\n")).collect()
}

fn strip_list_marker(line: &str) -> Option<(&str, usize)> {
    let indent = line.len().saturating_sub(line.trim_start().len());
    let rest = &line[indent..];
    for sym in ["- ", "* ", "+ ", "• "] {
        if let Some(tail) = rest.strip_prefix(sym) {
            return Some((tail, indent + sym.len()));
        }
    }
    let digits_end = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits_end > 0 {
        let after_num = &rest[digits_end..];
        if let Some(tail) = after_num
            .strip_prefix(". ")
            .or_else(|| after_num.strip_prefix(") "))
        {
            return Some((tail, indent + digits_end + 2));
        }
    }
    None
}

#[must_use]
pub fn plan_auto_parallel(
    request: &str,
    explicit_coupling: Option<&[(usize, usize, f64)]>,
) -> ParallelPlan {
    let mut items = segment_request(request);
    if items.len() > AUTO_PARALLEL_MAX_ITEMS {
        items.truncate(AUTO_PARALLEL_MAX_ITEMS);
    }
    let mut context = Vec::new();
    let mut task_indices = Vec::new();
    let mut wrapup = Vec::new();

    for (idx, item) in items.iter().enumerate() {
        let low = item.to_ascii_lowercase();
        if low.ends_with(':') && item.split_whitespace().count() <= 10 {
            context.push(idx);
        } else if low.starts_with("verify ")
            || low.starts_with("run tests")
            || low.starts_with("commit ")
            || low.contains("final check")
        {
            wrapup.push(idx);
        } else {
            task_indices.push(idx);
        }
    }

    let n = items.len();
    let mut parent: Vec<usize> = (0..n).collect();
    let mut union = |a: usize, b: usize| {
        let mut ra = a;
        while parent[ra] != ra {
            ra = parent[ra];
        }
        let mut rb = b;
        while parent[rb] != rb {
            rb = parent[rb];
        }
        if ra != rb {
            let (lo, hi) = if ra < rb { (ra, rb) } else { (rb, ra) };
            parent[hi] = lo;
        }
    };

    if let Some(pairs) = explicit_coupling {
        for &(a, b, p_coupled) in pairs {
            if a < n && b < n && p_coupled >= AUTO_PARALLEL_COUPLED_AT {
                union(a, b);
            }
        }
    } else {
        // Heuristic lexical path/symbol overlap coupling when no judge probabilities supplied
        let token_sets: Vec<BTreeSet<String>> = items
            .iter()
            .map(|s| {
                s.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '.' && c != '/')
                    .filter(|w| w.len() >= 3)
                    .map(|w| w.to_ascii_lowercase())
                    .collect()
            })
            .collect();
        for &i in &task_indices {
            for &j in &task_indices {
                if j <= i {
                    continue;
                }
                let shared = token_sets[i].intersection(&token_sets[j]).count();
                let min_len = token_sets[i].len().min(token_sets[j].len()).max(1);
                if (shared as f64 / min_len as f64) >= AUTO_PARALLEL_COUPLED_AT {
                    union(i, j);
                }
            }
        }
    }

    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for idx in task_indices {
        let mut root = idx;
        while parent[root] != root {
            root = parent[root];
        }
        groups.entry(root).or_default().push(idx);
    }

    ParallelPlan {
        items,
        context,
        wrapup,
        subtasks: groups.into_values().collect(),
    }
}

/// Autoresearch structured METRIC / MAD confidence ratchet state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricDirection {
    Higher,
    Lower,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExperimentDecision {
    Keep,
    Discard,
    Crash,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedExperimentMetrics {
    pub primary_value: Option<f64>,
    pub metrics: BTreeMap<String, f64>,
    pub asi_notes: BTreeMap<String, String>,
}

#[must_use]
pub fn parse_autoresearch_output(stdout: &str, primary_name: &str) -> ParsedExperimentMetrics {
    let mut metrics = BTreeMap::new();
    let mut asi_notes = BTreeMap::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("METRIC ") {
            if let Some((k, v)) = rest.split_once('=') {
                if let Ok(num) = v.trim().parse::<f64>() {
                    if num.is_finite() {
                        metrics.insert(k.trim().to_owned(), num);
                    }
                }
            }
        } else if let Some(rest) = trimmed.strip_prefix("ASI ") {
            if let Some((k, v)) = rest.split_once('=') {
                asi_notes.insert(k.trim().to_owned(), SecretRedactor::redact(v.trim()));
            }
        }
    }
    let primary_value = metrics.get(primary_name).copied();
    ParsedExperimentMetrics {
        primary_value,
        metrics,
        asi_notes,
    }
}

#[must_use]
pub fn compute_mad_confidence(samples: &[f64], candidate: f64) -> f64 {
    if samples.len() < 2 || !candidate.is_finite() {
        return 0.0;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let median = if sorted.len() % 2 == 1 {
        sorted[sorted.len() / 2]
    } else {
        (sorted[sorted.len() / 2 - 1] + sorted[sorted.len() / 2]) * 0.5
    };
    let mut devs: Vec<f64> = sorted.iter().map(|v| (v - median).abs()).collect();
    devs.sort_by(f64::total_cmp);
    let mad = if devs.len() % 2 == 1 {
        devs[devs.len() / 2]
    } else {
        (devs[devs.len() / 2 - 1] + devs[devs.len() / 2]) * 0.5
    };
    let scale = (mad * 1.4826).max(1e-9);
    (candidate - median).abs() / scale
}

pub struct AutoresearchSession {
    pub primary_metric: String,
    pub direction: MetricDirection,
    pub best_value: Option<f64>,
    pub history: Vec<(String, f64, ExperimentDecision)>,
}

impl AutoresearchSession {
    #[must_use]
    pub fn new(primary_metric: impl Into<String>, direction: MetricDirection) -> Self {
        Self {
            primary_metric: primary_metric.into(),
            direction,
            best_value: None,
            history: Vec::new(),
        }
    }

    pub fn evaluate_run(
        &mut self,
        label: impl Into<String>,
        exit_code: i32,
        stdout: &str,
    ) -> ExperimentDecision {
        let parsed = parse_autoresearch_output(stdout, &self.primary_metric);
        let label = label.into();
        if exit_code != 0 {
            self.history.push((label, f64::NAN, ExperimentDecision::Crash));
            return ExperimentDecision::Crash;
        }
        let Some(val) = parsed.primary_value else {
            self.history.push((label, f64::NAN, ExperimentDecision::Crash));
            return ExperimentDecision::Crash;
        };
        let improved = match (self.best_value, self.direction) {
            (None, _) => true,
            (Some(best), MetricDirection::Higher) => val > best,
            (Some(best), MetricDirection::Lower) => val < best,
        };
        let decision = if improved {
            self.best_value = Some(val);
            ExperimentDecision::Keep
        } else {
            ExperimentDecision::Discard
        };
        self.history.push((label, val, decision));
        decision
    }
}

/// Async Worker contract executed inside a 2-way `PeerMeshGraph` + isolated external worktree.
#[derive(Debug, Clone)]
pub struct MeshWorkerSpec {
    pub agent_id: String,
    pub role: AgentRole,
    pub prompt: String,
    pub owned_paths: Vec<String>,
    pub model_hint: Option<String>,
    pub output_schema: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshWorkerResult {
    pub agent_id: String,
    pub ok: bool,
    pub raw_output: String,
    pub parsed_json: Option<Value>,
    pub worktree_path: Option<PathBuf>,
    pub merge_outcome: Option<WorktreeMergeOutcome>,
    pub error: Option<String>,
}

pub type MeshWorkerFuture = Pin<Box<dyn Future<Output = Result<String>> + Send>>;

/// Live 2-way all-to-all PeerMeshGraph async coordinator with `tokio::sync::Notify` wakeup,
/// isolated external Git worktree orchestration, `/review`, `advisor`, `auto-parallel`,
/// `autoresearch`, and `autolearn`.
pub struct SwarmRuntime {
    mesh: Arc<PeerMeshGraph>,
    notifiers: RwLock<HashMap<String, Arc<Notify>>>,
    worktrees: WorktreeManager,
    memory: Option<Arc<MemoryEngine>>,
}

impl SwarmRuntime {
    #[must_use]
    pub fn new(default_max_hops: u32, memory: Option<Arc<MemoryEngine>>) -> Self {
        Self {
            mesh: Arc::new(PeerMeshGraph::new(default_max_hops)),
            notifiers: RwLock::new(HashMap::new()),
            worktrees: WorktreeManager::default(),
            memory,
        }
    }

    #[must_use]
    pub fn with_worktree_base(
        default_max_hops: u32,
        worktree_base_dir: PathBuf,
        memory: Option<Arc<MemoryEngine>>,
    ) -> Self {
        Self {
            mesh: Arc::new(PeerMeshGraph::new(default_max_hops)),
            notifiers: RwLock::new(HashMap::new()),
            worktrees: WorktreeManager::new(WorktreeIsolationConfig {
                base_dir: worktree_base_dir,
            }),
            memory,
        }
    }

    #[must_use]
    pub fn mesh(&self) -> &Arc<PeerMeshGraph> {
        &self.mesh
    }

    #[must_use]
    pub fn worktrees(&self) -> &WorktreeManager {
        &self.worktrees
    }

    pub fn register_agent(
        &self,
        id: &str,
        role: AgentRole,
        owned_paths: Vec<String>,
        excluded_paths: Vec<String>,
    ) -> Result<AgentNode, AgentGraphError> {
        let node = self
            .mesh
            .register_agent(id, role, owned_paths, excluded_paths)?;
        let mut guard = self
            .notifiers
            .write()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        guard
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(Notify::new()));
        Ok(node)
    }

    pub fn connect_duplex(&self, a: &str, b: &str) -> Result<(), AgentGraphError> {
        self.mesh.connect_duplex(a, b, "duplex")
    }

    pub fn connect_all_to_all(&self, ids: &[&str]) -> Result<usize, AgentGraphError> {
        self.mesh.connect_all_to_all(ids, "all-to-all")
    }

    #[allow(clippy::too_many_arguments)]
    pub fn send_peer(
        &self,
        from_id: &str,
        to_id: &str,
        subject: &str,
        body: &str,
        expected_epoch: Option<u64>,
        max_hops: Option<u32>,
        now_ms: Option<i64>,
    ) -> Result<PeerMessage, AgentGraphError> {
        let msg = self.mesh.send_peer(
            from_id,
            to_id,
            subject,
            body,
            expected_epoch,
            max_hops,
            now_ms,
        )?;
        self.wake_agent(to_id);
        Ok(msg)
    }

    pub fn reply(
        &self,
        from_id: &str,
        to_id: &str,
        reply_to_seq: u64,
        topic: &str,
        body: &str,
        now_ms: Option<i64>,
    ) -> Result<PeerMessage, AgentGraphError> {
        let msg = self
            .mesh
            .reply(from_id, reply_to_seq, topic, body, now_ms)?;
        self.wake_agent(to_id);
        for rec in &msg.recipients {
            self.wake_agent(rec);
        }
        Ok(msg)
    }

    pub fn broadcast(
        &self,
        from_id: &str,
        subject: &str,
        body: &str,
        max_hops: Option<u32>,
        now_ms: Option<i64>,
    ) -> Result<PeerMessage, AgentGraphError> {
        let msg = self
            .mesh
            .broadcast(from_id, subject, body, max_hops, now_ms)?;
        self.wake_all();
        Ok(msg)
    }

    pub fn read_since(
        &self,
        agent_id: &str,
        since_seq: u64,
        mentions_only: bool,
    ) -> Result<Vec<PeerMessage>, AgentGraphError> {
        let msgs = self.mesh.read_since(agent_id, since_seq)?;
        if !mentions_only {
            return Ok(msgs);
        }
        let at_self = format!("@{agent_id}");
        Ok(msgs
            .into_iter()
            .filter(|m| {
                m.recipients.iter().any(|r| r == agent_id)
                    || m.payload.contains(&at_self)
                    || m.payload.contains("@all")
            })
            .collect())
    }

    /// Zero-CPU reactive wait until a matching peer message arrives after `since_seq`
    /// or `timeout` elapses.
    pub async fn wait_for_messages(
        &self,
        agent_id: &str,
        since_seq: u64,
        mentions_only: bool,
        timeout: Duration,
    ) -> Result<Vec<PeerMessage>, AgentGraphError> {
        let immediate = self.read_since(agent_id, since_seq, mentions_only)?;
        if !immediate.is_empty() {
            return Ok(immediate);
        }
        let notify = {
            let guard = self
                .notifiers
                .read()
                .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
            guard.get(agent_id).cloned()
        }
        .ok_or_else(|| AgentGraphError::UnknownAgent(agent_id.to_owned()))?;

        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = notify.notified();
            let msgs = self.read_since(agent_id, since_seq, mentions_only)?;
            if !msgs.is_empty() {
                return Ok(msgs);
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Ok(Vec::new());
            }
            let _ = tokio::time::timeout(deadline - now, notified).await;
        }
    }

    pub fn roster(&self) -> Result<Vec<AgentNode>, AgentGraphError> {
        self.mesh.agents()
    }

    pub fn edges(&self) -> Result<Vec<PeerLinkEdge>, AgentGraphError> {
        self.mesh.all_edges()
    }

    pub fn detect_stalls(
        &self,
        now_ms: i64,
        stale_after_ms: i64,
    ) -> Result<Vec<StalledPeerAlert>, AgentGraphError> {
        self.mesh.detect_stalled_conversations(now_ms, stale_after_ms)
    }

    pub fn evaluate_convergence(
        &self,
        now_ms: i64,
        stale_after_ms: i64,
    ) -> Result<ConvergenceReport, AgentGraphError> {
        self.mesh.convergence_status(now_ms, stale_after_ms)
    }

    #[must_use]
    pub fn snapshot(&self) -> Value {
        let nodes: Vec<Value> = self
            .mesh
            .agents()
            .unwrap_or_default()
            .into_iter()
            .map(|n| n.to_json())
            .collect();
        let edges: Vec<Value> = self
            .mesh
            .all_edges()
            .unwrap_or_default()
            .into_iter()
            .map(|e| e.to_json())
            .collect();
        let messages: Vec<Value> = self
            .mesh
            .all_messages()
            .unwrap_or_default()
            .into_iter()
            .map(|m| m.to_json())
            .collect();
        json!({
            "nodes": nodes,
            "edges": edges,
            "messages": messages,
            "worktreeBaseDir": self.worktrees.base_dir().to_string_lossy(),
        })
    }

    /// Execute parallel peer-mesh workers inside isolated external Git worktrees,
    /// validating disjoint path ownership, 2-way `PeerMeshGraph` links, and typed JSON schemas.
    pub async fn run_mesh_workers<F>(
        &self,
        repo_root: Option<&Path>,
        specs: Vec<MeshWorkerSpec>,
        max_concurrency: usize,
        apply_back: bool,
        executor: Arc<F>,
    ) -> Result<Vec<MeshWorkerResult>>
    where
        F: Fn(MeshWorkerSpec, Option<PathBuf>, Arc<PeerMeshGraph>) -> MeshWorkerFuture
            + Send
            + Sync
            + 'static,
    {
        if specs.is_empty() {
            return Ok(Vec::new());
        }
        let mut registered_ids = Vec::with_capacity(specs.len());
        for spec in &specs {
            self.register_agent(
                &spec.agent_id,
                spec.role,
                spec.owned_paths.clone(),
                Vec::new(),
            )?;
            registered_ids.push(spec.agent_id.clone());
        }
        let id_refs: Vec<&str> = registered_ids.iter().map(String::as_str).collect();
        self.connect_all_to_all(&id_refs)?;

        let baseline = match repo_root {
            Some(root) => Some(self.worktrees.capture_baseline(root)?),
            None => None,
        };
        let sem = Arc::new(Semaphore::new(max_concurrency.clamp(1, 8)));
        let mut tasks = Vec::with_capacity(specs.len());

        for spec in specs {
            let permit = sem.clone().acquire_owned().await?;
            let mesh = Arc::clone(&self.mesh);
            let exec = Arc::clone(&executor);
            let wt_handle = match (&baseline, spec.role) {
                (Some(base), AgentRole::Verifier) => {
                    let _ = base;
                    None
                }
                (Some(base), _) => Some(self.worktrees.create_worktree(&spec.agent_id, base)?),
                (None, _) => None,
            };
            let wt_dir = wt_handle.as_ref().map(|h| h.worktree_path.clone());
            let owned = spec.owned_paths.clone();
            let wt_base = self.worktrees.base_dir().to_path_buf();
            tasks.push(tokio::spawn(async move {
                let _permit = permit;
                let res = exec(spec.clone(), wt_dir.clone(), Arc::clone(&mesh)).await;
                let mut parsed_json = None;
                let mut ok = true;
                let mut err_msg = None;
                let mut raw_output = String::new();
                match res {
                    Ok(out) => {
                        raw_output = out;
                        if let Some(ref schema) = spec.output_schema {
                            match validate_typed_subagent_json(&raw_output, schema) {
                                Ok(v) => parsed_json = Some(v),
                                Err(e) => {
                                    ok = false;
                                    err_msg = Some(format!("schema validation failed: {e}"));
                                }
                            }
                        }
                    }
                    Err(e) => {
                        ok = false;
                        err_msg = Some(e.to_string());
                    }
                }
                let mut merge_outcome = None;
                if ok && apply_back {
                    if let Some(ref handle) = wt_handle {
                        let mgr = WorktreeManager::new(WorktreeIsolationConfig {
                            base_dir: wt_base.clone(),
                        });
                        let allowed = if owned.is_empty() {
                            None
                        } else {
                            Some(owned.as_slice())
                        };
                        match mgr.apply_delta_serialized(handle, allowed).await {
                            Ok(m) => {
                                if !m.applied {
                                    ok = false;
                                    err_msg = Some(m.message.clone());
                                }
                                merge_outcome = Some(m);
                            }
                            Err(e) => {
                                ok = false;
                                err_msg = Some(e.to_string());
                            }
                        }
                    }
                }
                if let Some(ref handle) = wt_handle {
                    let mgr = WorktreeManager::new(WorktreeIsolationConfig {
                        base_dir: wt_base,
                    });
                    let _ = mgr.cleanup(handle);
                }
                MeshWorkerResult {
                    agent_id: spec.agent_id,
                    ok,
                    raw_output,
                    parsed_json,
                    worktree_path: wt_dir,
                    merge_outcome,
                    error: err_msg,
                }
            }));
        }

        let mut results = Vec::with_capacity(tasks.len());
        for t in tasks {
            results.push(t.await?);
        }
        Ok(results)
    }

    /// Built-in parallel `/review` flow (`correctness`, `security`, `tests`) returning
    /// deduplicated P0-P3 findings validated against `review_output_schema()`.
    pub async fn run_parallel_review<F>(
        &self,
        subject_diff: &str,
        executor: Arc<F>,
    ) -> Result<ReviewVerdict>
    where
        F: Fn(MeshWorkerSpec, Option<PathBuf>, Arc<PeerMeshGraph>) -> MeshWorkerFuture
            + Send
            + Sync
            + 'static,
    {
        let schema = review_output_schema();
        let specs = vec![
            MeshWorkerSpec {
                agent_id: "review-correctness".to_owned(),
                role: AgentRole::Verifier,
                prompt: format!("Review correctness/cross-boundary dispatch bugs:\n{subject_diff}"),
                owned_paths: Vec::new(),
                model_hint: None,
                output_schema: Some(schema.clone()),
            },
            MeshWorkerSpec {
                agent_id: "review-security".to_owned(),
                role: AgentRole::Verifier,
                prompt: format!("Review security/injection/path/secret bugs:\n{subject_diff}"),
                owned_paths: Vec::new(),
                model_hint: None,
                output_schema: Some(schema.clone()),
            },
            MeshWorkerSpec {
                agent_id: "review-regression".to_owned(),
                role: AgentRole::Verifier,
                prompt: format!("Review test coverage & edge-case regressions:\n{subject_diff}"),
                owned_paths: Vec::new(),
                model_hint: None,
                output_schema: Some(schema),
            },
        ];

        let worker_results = self
            .run_mesh_workers(None, specs, 3, false, executor)
            .await?;

        let mut findings = Vec::new();
        let mut seen = BTreeSet::new();
        let mut any_incorrect = false;
        let mut conf_sum = 0.0f64;
        let mut valid_count = 0usize;
        let mut explanations = Vec::new();

        for wr in worker_results {
            if let Some(val) = wr.parsed_json {
                if let Ok(verdict) = serde_json::from_value::<ReviewVerdict>(val) {
                    if verdict.overall_correctness == "incorrect" {
                        any_incorrect = true;
                    }
                    conf_sum += verdict.confidence;
                    valid_count += 1;
                    explanations.push(format!("[{}] {}", wr.agent_id, verdict.explanation));
                    for f in verdict.findings {
                        let key = format!("{}:{}:{}", f.file_path, f.line_start, f.title);
                        if seen.insert(key) {
                            findings.push(f);
                        }
                    }
                }
            }
        }

        findings.sort_by(|a, b| {
            a.priority
                .cmp(&b.priority)
                .then_with(|| b.confidence.total_cmp(&a.confidence))
        });

        Ok(ReviewVerdict {
            overall_correctness: if any_incorrect || findings.iter().any(|f| f.priority == 0) {
                "incorrect".to_owned()
            } else {
                "correct".to_owned()
            },
            explanation: if explanations.is_empty() {
                "No valid reviewer outputs received.".to_owned()
            } else {
                explanations.join(" ")
            },
            confidence: if valid_count > 0 {
                conf_sum / valid_count as f64
            } else {
                0.0
            },
            findings,
        })
    }

    /// Prompt-cache-neutral `autolearn` post-turn capture into `MemoryEngine` (Hindsight + ACE).
    pub fn capture_autolearn_turn(
        &self,
        bank_id: &str,
        workspace_hash: &str,
        turn_key: &str,
        lesson_summary: &str,
        rule_bullet: Option<&str>,
        tags: &[String],
    ) -> Result<()> {
        let Some(ref mem) = self.memory else {
            return Ok(());
        };
        mem.retain(
            bank_id,
            RetainItemInput {
                namespace_path: "autolearn/episodes".to_owned(),
                key: turn_key.to_owned(),
                content: lesson_summary.to_owned(),
                context: Some("post-turn autolearn capture".to_owned()),
                tier: MemoryTier::Durable,
                kind: MemoryKind::Experience,
                scope: MemoryScope::Project,
                provenance: MemoryProvenance::AgentDerived,
                importance_bps: 8_000,
                tags: tags.to_vec(),
                links: Vec::new(),
                now_ms: None,
            },
        )?;
        if let Some(bullet) = rule_bullet {
            mem.upsert_ace_delta(
                &format!("ace-{turn_key}"),
                workspace_hash,
                tags,
                bullet,
                MemoryProvenance::VerifiedUser,
                true,
                None,
            )?;
        }
        Ok(())
    }

    fn wake_agent(&self, agent_id: &str) {
        if let Ok(guard) = self.notifiers.read() {
            if let Some(n) = guard.get(agent_id) {
                n.notify_waiters();
            }
        }
    }

    fn wake_all(&self) {
        if let Ok(guard) = self.notifiers.read() {
            for n in guard.values() {
                n.notify_waiters();
            }
        }
    }
}

/// Deferred tool schemas (`swarm_register`, `swarm_message`, `swarm_read`, `auto_parallel_plan`, `advisor_check`)
/// registered into `DeferredToolRegistry` so Token-0 stays lean.
#[must_use]
pub fn swarm_tool_specs() -> Vec<crate::plugin::ToolSpec> {
    vec![
        crate::plugin::ToolSpec {
            name: "swarm_register".into(),
            description: "Register a 2-way PeerMeshGraph agent node with disjoint owned paths.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "role": { "type": "string", "enum": ["coordinator", "worker", "specialist", "verifier", "subagent"] },
                    "owned_paths": { "type": "array", "items": { "type": "string" } },
                    "connect_to": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["id"],
                "additionalProperties": false
            }),
            read_only: false,
        },
        crate::plugin::ToolSpec {
            name: "swarm_message".into(),
            description: "Send a duplex A<->B peer message on PeerMeshGraph.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "from": { "type": "string" },
                    "to": { "type": "string" },
                    "subject": { "type": "string" },
                    "body": { "type": "string" },
                    "hop_count": { "type": "integer" }
                },
                "required": ["from", "to", "subject", "body"],
                "additionalProperties": false
            }),
            read_only: false,
        },
        crate::plugin::ToolSpec {
            name: "swarm_read".into(),
            description: "Read cursor-based peer messages (`read_since`) or inspect mesh snapshot.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "agent_id": { "type": "string" },
                    "since_seq": { "type": "integer" },
                    "mentions_only": { "type": "boolean" }
                },
                "additionalProperties": false
            }),
            read_only: true,
        },
        crate::plugin::ToolSpec {
            name: "auto_parallel_plan".into(),
            description: "Segment a multi-part request into parallel connected-component subtasks.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "request": { "type": "string" }
                },
                "required": ["request"],
                "additionalProperties": false
            }),
            read_only: true,
        },
        crate::plugin::ToolSpec {
            name: "advisor_check".into(),
            description: "Evaluate WATCHDOG.yml rules and emit bounded tail-only `<advisory>` hints.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "rule_id": { "type": "string" },
                    "severity": { "type": "string", "enum": ["nit", "concern", "blocker"] },
                    "message": { "type": "string" },
                    "watchdog_yaml": { "type": "string" },
                    "text": { "type": "string" }
                },
                "additionalProperties": false
            }),
            read_only: true,
        },
    ]
}

/// Live runtime JSON dispatcher for `swarm_*`, `auto_parallel_plan`, and `advisor_check` tools.
pub fn dispatch_swarm_tool_json(
    runtime: &SwarmRuntime,
    tool_name: &str,
    args: &Value,
) -> Result<String> {
    match tool_name {
        "swarm_register" => {
            let id = args
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("swarm_register requires string 'id'"))?;
            let role = match args.get("role").and_then(Value::as_str).unwrap_or("worker") {
                "coordinator" => AgentRole::Coordinator,
                "specialist" => AgentRole::Specialist,
                "verifier" => AgentRole::Verifier,
                "subagent" => AgentRole::Subagent,
                _ => AgentRole::Worker,
            };
            let owned: Vec<String> = args
                .get("owned_paths")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let node = runtime.register_agent(id, role, owned, Vec::new())?;
            if let Some(peers) = args.get("connect_to").and_then(Value::as_array) {
                for peer in peers.iter().filter_map(Value::as_str) {
                    let _ = runtime.connect_duplex(id, peer);
                }
            }
            Ok(node.to_json().to_string())
        }
        "swarm_message" => {
            let from = args
                .get("from")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("swarm_message requires 'from'"))?;
            let to = args
                .get("to")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("swarm_message requires 'to'"))?;
            let subject = args
                .get("subject")
                .and_then(Value::as_str)
                .unwrap_or("peer_note");
            let body = args
                .get("body")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("swarm_message requires 'body'"))?;
            let max_hops = args.get("hop_count").and_then(Value::as_u64).map(|v| v as u32);
            let msg = runtime.send_peer(from, to, subject, body, None, max_hops, None)?;
            Ok(msg.to_json().to_string())
        }
        "swarm_read" => {
            if let Some(agent_id) = args.get("agent_id").and_then(Value::as_str) {
                let since = args.get("since_seq").and_then(Value::as_u64).unwrap_or(0);
                let mentions = args
                    .get("mentions_only")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let msgs: Vec<Value> = runtime
                    .read_since(agent_id, since, mentions)?
                    .into_iter()
                    .map(|m| m.to_json())
                    .collect();
                Ok(json!({ "agent_id": agent_id, "messages": msgs }).to_string())
            } else {
                Ok(runtime.snapshot().to_string())
            }
        }
        "auto_parallel_plan" => {
            let req = args
                .get("request")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("auto_parallel_plan requires 'request'"))?;
            let plan = plan_auto_parallel(req, None);
            Ok(serde_json::to_string_pretty(&plan)?)
        }
        "advisor_check" => {
            if let (Some(yaml), Some(text)) = (
                args.get("watchdog_yaml").and_then(Value::as_str),
                args.get("text").and_then(Value::as_str),
            ) {
                let mut guard = AdvisorEmissionGuard::from_watchdog_yaml(yaml)?;
                let ems = guard.inspect_watchdog_rules(text, now_epoch_ms());
                return Ok(serde_json::to_string_pretty(&ems)?);
            }
            let rule_id = args
                .get("rule_id")
                .and_then(Value::as_str)
                .unwrap_or("advisor-manual");
            let sev = match args
                .get("severity")
                .and_then(Value::as_str)
                .unwrap_or("concern")
            {
                "nit" => AdvisorSeverity::Nit,
                "blocker" => AdvisorSeverity::Blocker,
                _ => AdvisorSeverity::Concern,
            };
            let msg = args
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("");
            let mut guard = AdvisorEmissionGuard::new(DEFAULT_ADVISOR_MAX_EMISSIONS, 0, Vec::new());
            let em = guard.evaluate_and_emit(rule_id, sev, msg, now_epoch_ms());
            Ok(serde_json::to_string_pretty(&em)?)
        }
        other => bail!("unknown swarm tool '{other}'"),
    }
}

fn is_reparse_or_symlink(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return true;
        }
    }
    false
}

#[allow(dead_code)]
fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn duplex_peer_mesh_notify_wakeup_and_parallel_review_schema_validation() {
        let rt = SwarmRuntime::new(4, None);
        rt.register_agent("coord", AgentRole::Coordinator, vec![], vec![])
            .unwrap();
        rt.register_agent("worker-a", AgentRole::Worker, vec!["rust/a.rs".to_owned()], vec![])
            .unwrap();
        rt.register_agent("worker-b", AgentRole::Worker, vec!["rust/b.rs".to_owned()], vec![])
            .unwrap();
        rt.connect_all_to_all(&["coord", "worker-a", "worker-b"]).unwrap();

        let rt_clone = Arc::new(rt);
        let rt_sender = Arc::clone(&rt_clone);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(15)).await;
            let _ = rt_sender.send_peer(
                "worker-a",
                "worker-b",
                "schema_ready",
                "@worker-b payload ready",
                None,
                None,
                Some(100),
            );
        });

        let woken = rt_clone
            .wait_for_messages("worker-b", 0, true, Duration::from_secs(2))
            .await
            .expect("wait");
        assert_eq!(woken.len(), 1);
        assert_eq!(woken[0].from_id, "worker-a");

        // Built-in parallel /review with schema validation & deduplication
        let exec = Arc::new(
            |spec: MeshWorkerSpec, _wt: Option<PathBuf>, _mesh: Arc<PeerMeshGraph>| -> MeshWorkerFuture {
                Box::pin(async move {
                    if spec.agent_id == "review-security" {
                        Ok(r#"```json
                        {
                          "overall_correctness": "incorrect",
                          "explanation": "Found path traversal bug.",
                          "confidence": 0.95,
                          "findings": [{
                            "title": "Validate canonical root containment",
                            "body": "Join without canonical starts_with allows escape.",
                            "priority": 0,
                            "confidence": 0.95,
                            "file_path": "rust/a.rs",
                            "line_start": 10,
                            "line_end": 14
                          }]
                        }
                        ```"#
                        .to_owned())
                    } else {
                        Ok(r#"{"overall_correctness":"correct","explanation":"Clean.","confidence":0.9,"findings":[]}"#.to_owned())
                    }
                })
            },
        );
        let verdict = rt_clone
            .run_parallel_review("diff --git a/rust/a.rs", exec)
            .await
            .expect("review");
        assert_eq!(verdict.overall_correctness, "incorrect");
        assert_eq!(verdict.findings.len(), 1);
        assert_eq!(verdict.findings[0].priority, 0);
    }

    #[tokio::test]
    async fn isolated_git_worktree_captures_and_applies_delta_cleanly_outside_repo() {
        let tmp_root = std::env::temp_dir().join(format!("omnia-wt-test-{}", Uuid::new_v4().simple()));
        let repo = tmp_root.join("repo");
        let wt_base = tmp_root.join("external_worktrees");
        fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init"]).unwrap();
        run_git(&repo, &["config", "user.name", "omnia-test"]).unwrap();
        run_git(&repo, &["config", "user.email", "omnia-test@example.test"]).unwrap();
        fs::write(repo.join("owned.rs"), "pub fn val() -> i32 { 1 }\n").unwrap();
        fs::write(repo.join("wip.rs"), "pub fn wip() -> i32 { 10 }\n").unwrap();
        run_git(&repo, &["add", "owned.rs"]).unwrap();
        run_git(&repo, &["commit", "-m", "init"]).unwrap();

        let mgr = WorktreeManager::new(WorktreeIsolationConfig {
            base_dir: wt_base.clone(),
        });
        let base = mgr.capture_baseline(&repo).expect("baseline");
        assert_eq!(base.untracked_files.len(), 1);

        let handle = mgr.create_worktree("worker-a", &base).expect("create wt");
        assert!(handle.worktree_path.starts_with(fs::canonicalize(&wt_base).unwrap()));
        assert!(handle.worktree_path.join("wip.rs").exists());

        fs::write(handle.worktree_path.join("owned.rs"), "pub fn val() -> i32 { 42 }\n").unwrap();
        let outcome = mgr
            .apply_delta_serialized(&handle, Some(&["owned.rs".to_owned()]))
            .await
            .expect("merge back");
        assert!(outcome.applied);
        assert!(fs::read_to_string(repo.join("owned.rs")).unwrap().contains("42"));
        mgr.cleanup(&handle).expect("cleanup");
        let _ = fs::remove_dir_all(&tmp_root);
    }

    #[test]
    fn advisor_watchdog_auto_parallel_and_autoresearch_mad() {
        let mut guard = AdvisorEmissionGuard::from_watchdog_yaml(
            "rules:\n  - id: prefix0\n    pattern: mutate system prompt\n    severity: blocker\n    message: Keep BASE_SYSTEM_PROMPT immutable.\n",
        )
        .expect("parse watchdog");
        let ems = guard.inspect_watchdog_rules("Do not mutate system prompt mid-run", 1_000);
        assert_eq!(ems.len(), 1);
        assert!(ems[0].xml_block.contains("Keep BASE_SYSTEM_PROMPT immutable."));
        // Duplicate suppressed
        assert!(guard
            .inspect_watchdog_rules("Do not mutate system prompt mid-run", 10_000)
            .is_empty());

        let plan = plan_auto_parallel(
            "Refactor modules:\n- Update auth in rust/auth.rs\n- Update billing in rust/billing.rs\n- Run tests across workspace",
            None,
        );
        assert_eq!(plan.context, vec![0]);
        assert_eq!(plan.subtasks.len(), 2);
        assert_eq!(plan.wrapup, vec![3]);

        let mut ar = AutoresearchSession::new("pass_rate", MetricDirection::Higher);
        assert_eq!(
            ar.evaluate_run("base", 0, "METRIC pass_rate=0.60\nASI note=baseline"),
            ExperimentDecision::Keep
        );
        assert_eq!(
            ar.evaluate_run("worse", 0, "METRIC pass_rate=0.55"),
            ExperimentDecision::Discard
        );
        assert_eq!(
            ar.evaluate_run("better", 0, "METRIC pass_rate=0.80"),
            ExperimentDecision::Keep
        );
        assert!(compute_mad_confidence(&[0.55, 0.58, 0.60, 0.61], 0.80) > 2.0);
    }
}
