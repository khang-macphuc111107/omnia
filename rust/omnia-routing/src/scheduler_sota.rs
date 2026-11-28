#![forbid(unsafe_code)]

//! SOTA multi-account scheduler extensions, Combo DAG failover, retired/not-served
//! classifiers, and 3-way billing-safe post-dispatch classification (`htmustc-proxy` +
//! `khangmacphuc-omnia` v20/v22 distillation).

use std::collections::{BTreeMap, HashMap, HashSet};

use omnia_core::SecretRedactor;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{AcceptanceState, ReservationStatus};

/// Transient non-punishing soft-fail demotion window in milliseconds (`5s`).
pub const DEFAULT_SOFT_FAIL_WINDOW_MS: i64 = 5_000;
/// Maximum permitted provider-stated or inferred quota exhaustion window (`7d`).
pub const MAX_QUOTA_EXHAUSTION_MS: i64 = 7 * 24 * 3_600 * 1_000;
/// Maximum nesting depth when resolving hierarchical `combo/<id>` chains.
pub const COMBO_MAX_DEPTH: usize = 4;
/// Active health-recovery probe interval for benched combo members (`30s`).
pub const COMBO_PROBE_INTERVAL_MS: i64 = 30_000;

/// Pool-wide stated quota reset summary returned when all matching candidates are cooling on `QuotaResetAt`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuotaResetPoolStatus {
    pub error_code: String,
    pub reset_at_ms: i64,
    pub resets_in_seconds: u64,
    pub retry_after_secs: u64,
    pub candidate_count: usize,
}

impl QuotaResetPoolStatus {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "error_code": self.error_code,
            "code": self.error_code,
            "reset_at_ms": self.reset_at_ms,
            "resets_in_seconds": self.resets_in_seconds,
            "retry_after_secs": self.retry_after_secs,
            "candidate_count": self.candidate_count,
        })
    }
}

/// Decision returned by [`NotServedTracker`] after inspecting an upstream 404 / unserved response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum NotServedDecision {
    /// At least one sibling candidate remains untried or previously succeeded; continue failover.
    ContinueFailover {
        failed_candidates: usize,
        eligible_pool_size: usize,
    },
    /// Every eligible candidate in the pool returned unserved 404; abort retries immediately with 404.
    ModelNotFound404 {
        error_code: String,
        model_id: String,
        failed_candidates: usize,
    },
}

#[derive(Debug, Clone, Default)]
struct NotServedEntry {
    failed_candidates: HashSet<String>,
    any_served: bool,
}

/// Prevents 12-hour `429 Retry-After: 1` retry storms when an entire account pool lacks a model.
#[derive(Debug, Clone, Default)]
pub struct NotServedTracker {
    entries: HashMap<(String, String), NotServedEntry>,
}

impl NotServedTracker {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `true` if `err_message` matches upstream "model not served / entity not found" patterns.
    #[must_use]
    pub fn is_not_served_message(http_status: u16, err_message: &str) -> bool {
        if http_status != 404 && !err_message.to_ascii_lowercase().contains("404") {
            return false;
        }
        let lower = err_message.to_ascii_lowercase();
        lower.contains("requested entity was not found")
            || lower.contains("model_not_found")
            || lower.contains("not_found")
            || lower.contains("does not exist")
    }

    /// Record a bare `404` / not-served failure for `(pool_key, model_id, candidate_id)`.
    pub fn record_not_served(
        &mut self,
        pool_key: &str,
        model_id: &str,
        candidate_id: &str,
        eligible_pool_size: usize,
    ) -> NotServedDecision {
        let key = (
            pool_key.trim().to_ascii_lowercase(),
            model_id.trim().to_ascii_lowercase(),
        );
        let entry = self.entries.entry(key).or_default();
        entry.failed_candidates.insert(candidate_id.to_owned());
        let target_size = eligible_pool_size.max(1);
        if !entry.any_served && entry.failed_candidates.len() >= target_size {
            NotServedDecision::ModelNotFound404 {
                error_code: "model_not_found".to_owned(),
                model_id: model_id.to_owned(),
                failed_candidates: entry.failed_candidates.len(),
            }
        } else {
            NotServedDecision::ContinueFailover {
                failed_candidates: entry.failed_candidates.len(),
                eligible_pool_size: target_size,
            }
        }
    }

    /// Record a successful non-404 service response for `(pool_key, model_id)` and clear unserved state.
    pub fn record_served(&mut self, pool_key: &str, model_id: &str) {
        let key = (
            pool_key.trim().to_ascii_lowercase(),
            model_id.trim().to_ascii_lowercase(),
        );
        self.entries.insert(
            key,
            NotServedEntry {
                failed_candidates: HashSet::new(),
                any_served: true,
            },
        );
    }

    /// Query whether every known candidate for `(pool_key, model_id)` failed as unserved.
    #[must_use]
    pub fn is_model_unserved(&self, pool_key: &str, model_id: &str, eligible_pool_size: usize) -> bool {
        let key = (
            pool_key.trim().to_ascii_lowercase(),
            model_id.trim().to_ascii_lowercase(),
        );
        self.entries.get(&key).is_some_and(|e| {
            !e.any_served && e.failed_candidates.len() >= eligible_pool_size.max(1)
        })
    }

    pub fn clear_model(&mut self, pool_key: &str, model_id: &str) {
        let key = (
            pool_key.trim().to_ascii_lowercase(),
            model_id.trim().to_ascii_lowercase(),
        );
        self.entries.remove(&key);
    }
}

/// Canned HTTP-200 retirement notice returned by upstream endpoints when a model is sunset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRetiredError {
    pub http_status: u16,
    pub error_code: String,
    pub retired_model: String,
    pub successor_model: Option<String>,
    pub raw_notice: String,
}

impl ModelRetiredError {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "http_status": self.http_status,
            "error_code": self.error_code,
            "retired_model": self.retired_model,
            "successor_model": self.successor_model,
            "message": self.raw_notice,
        })
    }
}

/// Detect Google Code Assist / compatible HTTP-200 canned retirement notices without blaming accounts.
///
/// Mirrors `htmustc-proxy/internal/proxy/model_retired.go`: returns `None` if real response
/// structural fields (`usageMetadata`, `modelVersion`, `responseId`, `finishReason`, or `role`) are present.
#[must_use]
pub fn detect_retired_model_notice(raw_payload_or_sse: &str) -> Option<ModelRetiredError> {
    let trimmed = raw_payload_or_sse.trim();
    if trimmed.is_empty() {
        return None;
    }
    let structural_markers = [
        "\"usageMetadata\"",
        "\"modelVersion\"",
        "\"responseId\"",
        "\"finishReason\"",
        "\"finish_reason\"",
        "\"role\"",
        "\"tool_calls\"",
    ];
    if structural_markers.iter().any(|m| trimmed.contains(m)) {
        return None;
    }

    let extracted_text = extract_candidate_notice_text(trimmed);
    let hay = extracted_text.as_deref().unwrap_or(trimmed);
    let lower = hay.to_ascii_lowercase();
    let needle = "is no longer available";
    let avail_idx = lower.find(needle)?;

    let prefix = hay[..avail_idx].trim();
    let retired_model = prefix
        .split_whitespace()
        .last()
        .unwrap_or("")
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | ',' | ':'))
        .to_owned();
    if retired_model.is_empty() {
        return None;
    }

    let after = &hay[avail_idx + needle.len()..];
    let after_lower = after.to_ascii_lowercase();
    let successor_model = after_lower.find("please switch to ").and_then(|pos| {
        let tail = after[pos + "please switch to ".len()..].trim();
        let token = tail
            .split(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '"' | '\'' | ')'))
            .find(|s| !s.is_empty())?
            .trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '.'));
        (!token.is_empty()).then(|| token.to_owned())
    });

    Some(ModelRetiredError {
        http_status: 404,
        error_code: "model_retired".to_owned(),
        retired_model,
        successor_model,
        raw_notice: SecretRedactor::redact(&hay.chars().take(320).collect::<String>()),
    })
}

fn extract_candidate_notice_text(raw: &str) -> Option<String> {
    let json_slice = raw
        .lines()
        .find_map(|line| line.trim().strip_prefix("data:").map(str::trim))
        .unwrap_or(raw);
    let val: Value = serde_json::from_str(json_slice).ok()?;
    val.pointer("/response/candidates/0/content/parts/0/text")
        .or_else(|| val.pointer("/candidates/0/content/parts/0/text"))
        .or_else(|| val.pointer("/choices/0/delta/content"))
        .or_else(|| val.pointer("/choices/0/message/content"))
        .or_else(|| val.pointer("/error/message"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

/// Failover strategy for a virtual `combo/<id>` route definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ComboStrategy {
    #[default]
    Fallback,
    RoundRobin,
    Random,
}

/// Declarative virtual model chain supporting nested combo expansion and self-shadowing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComboDefinition {
    pub id: String,
    pub strategy: ComboStrategy,
    pub members: Vec<String>,
}

/// Active probe target due for `ComboProbe` health recovery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComboProbeTarget {
    pub combo_id: String,
    pub member_id: String,
}

/// Outcome of an active 30s `ComboProbe` check against a benched primary combo member.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComboProbeOutcome {
    Healthy,
    StillFailing,
    /// Upstream probe was inconclusive (`ErrComboProbeUndecided`); restore so real traffic decides.
    Undecided,
}

/// Resolved ordered candidate list produced by [`ComboRegistry::resolve`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComboResolution {
    pub combo_id: String,
    pub strategy: ComboStrategy,
    pub active_members: Vec<String>,
    pub benched_tail_members: Vec<String>,
}

impl ComboResolution {
    /// Returns all reachable members in priority order (active heads first, benched tails last).
    #[must_use]
    pub fn ordered_targets(&self) -> Vec<String> {
        let mut out = Vec::with_capacity(self.active_members.len() + self.benched_tail_members.len());
        out.extend(self.active_members.iter().cloned());
        out.extend(self.benched_tail_members.iter().cloned());
        out
    }
}

#[derive(Debug, Clone)]
struct ComboBenchState {
    benched_at_ms: i64,
    last_probe_ms: i64,
    probing: bool,
}

/// Nested `ComboSet` DAG failover registry with member-scoped `demote_benched` (never drops
/// last-resort members) and anti-stampede `30s` `ComboProbe` recovery.
#[derive(Debug, Clone, Default)]
pub struct ComboRegistry {
    combos: BTreeMap<String, ComboDefinition>,
    rr_cursors: HashMap<String, usize>,
    benched: HashMap<(String, String), ComboBenchState>,
    rng_state: u64,
}

impl ComboRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self {
            combos: BTreeMap::new(),
            rr_cursors: HashMap::new(),
            benched: HashMap::new(),
            rng_state: 0x9e37_79b9_7f4a_7c15,
        }
    }

    pub fn upsert(&mut self, def: ComboDefinition) {
        let norm = normalize_combo_key(&def.id);
        self.combos.insert(
            norm.clone(),
            ComboDefinition {
                id: norm,
                strategy: def.strategy,
                members: def.members,
            },
        );
    }

    #[must_use]
    pub fn get(&self, name_or_prefixed: &str) -> Option<&ComboDefinition> {
        self.combos.get(&normalize_combo_key(name_or_prefixed))
    }

    /// Resolve a virtual `combo/<id>` into a flat ordered list of concrete targets, expanding
    /// nested combos up to `COMBO_MAX_DEPTH = 4` while allowing self-shadowing leaf resolution.
    #[must_use]
    pub fn resolve(&mut self, target: &str, now_ms: i64) -> ComboResolution {
        let combo_id = normalize_combo_key(target);
        let strategy = self
            .combos
            .get(&combo_id)
            .map_or(ComboStrategy::Fallback, |c| c.strategy);
        let mut seen_stack = Vec::new();
        let mut flat = Vec::new();
        self.expand_recursive(&combo_id, 0, &mut seen_stack, &mut flat);

        let rotated = match strategy {
            ComboStrategy::Fallback => flat,
            ComboStrategy::RoundRobin if !flat.is_empty() => {
                let cursor = self.rr_cursors.entry(combo_id.clone()).or_insert(0);
                let shift = *cursor % flat.len();
                *cursor = cursor.wrapping_add(1);
                let mut v = Vec::with_capacity(flat.len());
                v.extend_from_slice(&flat[shift..]);
                v.extend_from_slice(&flat[..shift]);
                v
            }
            ComboStrategy::Random if flat.len() > 1 => {
                let mut v = flat;
                for i in (1..v.len()).rev() {
                    self.rng_state = splitmix64_next(self.rng_state.wrapping_add(i as u64 + 1));
                    let j = (self.rng_state as usize) % (i + 1);
                    v.swap(i, j);
                }
                v
            }
            _ => flat,
        };

        let mut active_members = Vec::new();
        let mut benched_tail_members = Vec::new();
        for member in rotated {
            let key = (combo_id.clone(), member.clone());
            if let Some(st) = self.benched.get(&key) {
                let _ = (now_ms, st.benched_at_ms);
                benched_tail_members.push(member);
            } else {
                active_members.push(member);
            }
        }
        ComboResolution {
            combo_id,
            strategy,
            active_members,
            benched_tail_members,
        }
    }

    fn expand_recursive(
        &self,
        combo_id: &str,
        depth: usize,
        stack: &mut Vec<String>,
        out: &mut Vec<String>,
    ) {
        let Some(def) = self.combos.get(combo_id) else {
            return;
        };
        stack.push(combo_id.to_owned());
        for raw_member in &def.members {
            let trimmed = raw_member.trim();
            if trimmed.is_empty() {
                continue;
            }
            let norm = normalize_combo_key(trimmed);
            // Self-shadowing (`combo "gpt-4o" -> ["gpt-4o", "claude-sonnet"]`) resolves the
            // matching entry as a real leaf model instead of flagging an infinite cycle.
            if norm == combo_id {
                push_unique(out, trimmed);
                continue;
            }
            if let Some(_nested) = self.combos.get(&norm) {
                if depth + 1 < COMBO_MAX_DEPTH && !stack.contains(&norm) {
                    self.expand_recursive(&norm, depth + 1, stack, out);
                }
            } else {
                push_unique(out, trimmed);
            }
        }
        stack.pop();
    }

    /// Demote a failing member strictly within `(combo_id, member_id)` to the fallback tail
    /// without dropping it from last-resort reachability or benching sibling members.
    pub fn record_member_failure(&mut self, combo_id: &str, member_id: &str, now_ms: i64) {
        let norm_combo = normalize_combo_key(combo_id);
        self.benched
            .entry((norm_combo, member_id.trim().to_owned()))
            .or_insert(ComboBenchState {
                benched_at_ms: now_ms,
                last_probe_ms: now_ms,
                probing: false,
            });
    }

    /// Restore a member immediately to active priority order upon success.
    pub fn record_member_success(&mut self, combo_id: &str, member_id: &str) {
        let norm_combo = normalize_combo_key(combo_id);
        self.benched.remove(&(norm_combo, member_id.trim().to_owned()));
    }

    /// Collect members due for active `30s` `ComboProbe` recovery without stampeding.
    pub fn claim_due_probes(&mut self, now_ms: i64) -> Vec<ComboProbeTarget> {
        let mut due = Vec::new();
        for ((combo_id, member_id), st) in &mut self.benched {
            if !st.probing && now_ms.saturating_sub(st.last_probe_ms) >= COMBO_PROBE_INTERVAL_MS {
                st.probing = true;
                st.last_probe_ms = now_ms;
                due.push(ComboProbeTarget {
                    combo_id: combo_id.clone(),
                    member_id: member_id.clone(),
                });
            }
        }
        due
    }

    /// Complete an active probe. Both `Healthy` and `Undecided` restore primary ordering so real
    /// traffic makes the final call.
    pub fn complete_probe(
        &mut self,
        combo_id: &str,
        member_id: &str,
        outcome: ComboProbeOutcome,
        now_ms: i64,
    ) {
        let key = (normalize_combo_key(combo_id), member_id.trim().to_owned());
        match outcome {
            ComboProbeOutcome::Healthy | ComboProbeOutcome::Undecided => {
                self.benched.remove(&key);
            }
            ComboProbeOutcome::StillFailing => {
                if let Some(st) = self.benched.get_mut(&key) {
                    st.probing = false;
                    st.last_probe_ms = now_ms;
                }
            }
        }
    }

    /// Non-mutating snapshot of a combo resolution for observability read-outs.
    #[must_use]
    pub fn peek_chain(&self, target: &str) -> ComboResolution {
        let combo_id = normalize_combo_key(target);
        let strategy = self
            .combos
            .get(&combo_id)
            .map_or(ComboStrategy::Fallback, |c| c.strategy);
        let mut stack = Vec::new();
        let mut flat = Vec::new();
        self.expand_recursive(&combo_id, 0, &mut stack, &mut flat);
        let mut active_members = Vec::new();
        let mut benched_tail_members = Vec::new();
        for m in flat {
            if self.benched.contains_key(&(combo_id.clone(), m.clone())) {
                benched_tail_members.push(m);
            } else {
                active_members.push(m);
            }
        }
        ComboResolution {
            combo_id,
            strategy,
            active_members,
            benched_tail_members,
        }
    }
}

fn normalize_combo_key(raw: &str) -> String {
    let trimmed = raw.trim();
    let stripped = trimmed
        .strip_prefix("combo/")
        .or_else(|| trimmed.strip_prefix("COMBO/"))
        .unwrap_or(trimmed);
    stripped.trim().to_owned()
}

fn push_unique(vec: &mut Vec<String>, item: &str) {
    if !vec.iter().any(|existing| existing == item) {
        vec.push(item.to_owned());
    }
}

#[must_use]
pub fn splitmix64_next(mut state: u64) -> u64 {
    state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut z = state;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// Canonical 3-way post-dispatch outcome classification preventing blind duplicate billing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DispatchOutcomeClass {
    Accepted,
    NotAccepted,
    Unknown,
}

impl DispatchOutcomeClass {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "Accepted",
            Self::NotAccepted => "NotAccepted",
            Self::Unknown => "Unknown",
        }
    }

    #[must_use]
    pub const fn to_acceptance_state(self) -> AcceptanceState {
        match self {
            Self::Accepted => AcceptanceState::Accepted,
            Self::NotAccepted => AcceptanceState::NotSent,
            Self::Unknown => AcceptanceState::Unknown,
        }
    }

    #[must_use]
    pub const fn from_acceptance_state(state: AcceptanceState) -> Self {
        match state {
            AcceptanceState::Accepted => Self::Accepted,
            AcceptanceState::NotSent => Self::NotAccepted,
            AcceptanceState::Unknown => Self::Unknown,
        }
    }

    #[must_use]
    pub const fn target_reservation_status(self) -> ReservationStatus {
        match self {
            Self::Accepted => ReservationStatus::ReconciledCharged,
            Self::NotAccepted => ReservationStatus::ReconciledReleased,
            Self::Unknown => ReservationStatus::OperatorRecoveryRequired,
        }
    }

    #[must_use]
    pub const fn blocks_automatic_retry(self) -> bool {
        !matches!(self, Self::NotAccepted)
    }
}

/// Wire-level telemetry input fed into [`classify_post_dispatch_outcome`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PostDispatchInput {
    /// Upstream HTTP status if response headers arrived before failure/completion.
    pub http_status: Option<u16>,
    /// Number of response bytes read after sending the request.
    pub bytes_received: usize,
    /// Whether the upstream request-acceptance marker or partial content payload was observed.
    pub upstream_accepted: bool,
    /// Whether a complete terminal event (`[DONE]`, `message_stop`, `response.completed`, or full JSON) arrived.
    pub terminal_received: bool,
    /// True if connection failed before request bytes were acknowledged by upstream.
    pub pre_dispatch_connect_error: bool,
    /// True if stream dropped or timed out mid-response after acceptance.
    pub stream_dropped: bool,
}

/// Deterministic 3-way billing-safe classification result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PostDispatchClassification {
    pub outcome_class: DispatchOutcomeClass,
    pub acceptance_state: AcceptanceState,
    pub reservation_status: ReservationStatus,
    pub retry_safe: bool,
    pub blocks_auto_retry: bool,
    pub reason: String,
}

/// Classify a dispatched provider attempt into `Accepted`, `NotAccepted`, or `Unknown`.
///
/// Crucially guarantees that a stream drop after HTTP `200` acceptance or partial output bytes
/// (without terminal completion) becomes `Unknown` (`OperatorRecoveryRequired`), blocking blind
/// automatic retries that would silently double-bill or duplicate side effects.
#[must_use]
pub fn classify_post_dispatch_outcome(input: &PostDispatchInput) -> PostDispatchClassification {
    let outcome = if input.pre_dispatch_connect_error {
        DispatchOutcomeClass::NotAccepted
    } else if let Some(status) = input.http_status {
        if status >= 400 {
            DispatchOutcomeClass::NotAccepted
        } else if input.terminal_received && !input.stream_dropped {
            DispatchOutcomeClass::Accepted
        } else if input.stream_dropped || input.bytes_received > 0 || input.upstream_accepted {
            DispatchOutcomeClass::Unknown
        } else {
            DispatchOutcomeClass::NotAccepted
        }
    } else if input.terminal_received && !input.stream_dropped {
        DispatchOutcomeClass::Accepted
    } else if input.upstream_accepted || input.bytes_received > 0 || input.stream_dropped {
        DispatchOutcomeClass::Unknown
    } else {
        DispatchOutcomeClass::NotAccepted
    };

    let reason = match outcome {
        DispatchOutcomeClass::Accepted => "upstream_completed_with_terminal_receipt".to_owned(),
        DispatchOutcomeClass::NotAccepted => {
            if let Some(st) = input.http_status.filter(|&s| s >= 400) {
                format!("upstream_rejected_http_{st}")
            } else {
                "pre_acceptance_transport_failure".to_owned()
            }
        }
        DispatchOutcomeClass::Unknown => {
            "post_acceptance_wire_drop_without_terminal_blocks_auto_retry".to_owned()
        }
    };

    PostDispatchClassification {
        outcome_class: outcome,
        acceptance_state: outcome.to_acceptance_state(),
        reservation_status: outcome.target_reservation_status(),
        retry_safe: !outcome.blocks_automatic_retry(),
        blocks_auto_retry: outcome.blocks_automatic_retry(),
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_served_tracker_prevents_retry_storm_after_all_eligible_404() {
        let mut tracker = NotServedTracker::new();
        assert!(NotServedTracker::is_not_served_message(
            404,
            "Requested entity was not found"
        ));
        assert!(!NotServedTracker::is_not_served_message(
            429,
            "Rate limit exceeded"
        ));

        let d1 = tracker.record_not_served("gemini", "gemini-3-pro", "acct-1", 2);
        assert!(matches!(d1, NotServedDecision::ContinueFailover { .. }));
        assert!(!tracker.is_model_unserved("gemini", "gemini-3-pro", 2));

        let d2 = tracker.record_not_served("gemini", "gemini-3-pro", "acct-2", 2);
        assert_eq!(
            d2,
            NotServedDecision::ModelNotFound404 {
                error_code: "model_not_found".to_owned(),
                model_id: "gemini-3-pro".to_owned(),
                failed_candidates: 2,
            }
        );
        assert!(tracker.is_model_unserved("gemini", "gemini-3-pro", 2));

        tracker.record_served("gemini", "gemini-3-pro");
        assert!(!tracker.is_model_unserved("gemini", "gemini-3-pro", 2));
    }

    #[test]
    fn retired_model_notice_detects_canned_200_and_ignores_real_replies() {
        let sse = "data: {\"response\":{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"gemini-2.0-flash-exp is no longer available. Please switch to gemini-2.5-flash.\"}]}}]}}\n\n";
        let retired = detect_retired_model_notice(sse).expect("retired notice detected");
        assert_eq!(retired.http_status, 404);
        assert_eq!(retired.error_code, "model_retired");
        assert_eq!(retired.retired_model, "gemini-2.0-flash-exp");
        assert_eq!(retired.successor_model.as_deref(), Some("gemini-2.5-flash"));

        let real_reply = "data: {\"response\":{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"gemini-2.0-flash-exp is no longer available. Please switch to gemini-2.5-flash.\"}]},\"finishReason\":\"STOP\"}]}}\n\n";
        assert!(
            detect_retired_model_notice(real_reply).is_none(),
            "structural model reply explaining deprecation must NOT trigger ModelRetiredError"
        );
    }

    #[test]
    fn combo_registry_handles_nested_self_shadowing_bench_and_30s_probe() {
        let mut reg = ComboRegistry::new();
        reg.upsert(ComboDefinition {
            id: "gpt-4o".to_owned(),
            strategy: ComboStrategy::Fallback,
            members: vec!["gpt-4o".to_owned(), "combo/backup".to_owned()],
        });
        reg.upsert(ComboDefinition {
            id: "backup".to_owned(),
            strategy: ComboStrategy::Fallback,
            members: vec!["claude-sonnet".to_owned(), "gemini-pro".to_owned()],
        });

        let r0 = reg.resolve("combo/gpt-4o", 1_000);
        assert_eq!(
            r0.ordered_targets(),
            vec!["gpt-4o", "claude-sonnet", "gemini-pro"]
        );

        // Failing member moves to tail (demote-never-drop) without poisoning siblings.
        reg.record_member_failure("combo/gpt-4o", "gpt-4o", 1_000);
        let r1 = reg.resolve("combo/gpt-4o", 2_000);
        assert_eq!(
            r1.active_members,
            vec!["claude-sonnet", "gemini-pro"]
        );
        assert_eq!(r1.benched_tail_members, vec!["gpt-4o"]);
        assert_eq!(
            r1.ordered_targets(),
            vec!["claude-sonnet", "gemini-pro", "gpt-4o"]
        );

        // Probe before 30s does not fire; at +30s fires once (anti-stampede).
        assert!(reg.claim_due_probes(29_999).is_empty());
        let due = reg.claim_due_probes(31_000);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].member_id, "gpt-4o");
        assert!(reg.claim_due_probes(31_001).is_empty());

        reg.complete_probe("gpt-4o", "gpt-4o", ComboProbeOutcome::Undecided, 31_100);
        let r2 = reg.resolve("combo/gpt-4o", 31_200);
        assert_eq!(
            r2.active_members,
            vec!["gpt-4o", "claude-sonnet", "gemini-pro"]
        );
    }

    #[test]
    fn post_dispatch_three_way_classifier_blocks_auto_retry_on_unknown_wire_drop() {
        let not_accepted = classify_post_dispatch_outcome(&PostDispatchInput {
            http_status: Some(502),
            bytes_received: 128,
            ..Default::default()
        });
        assert_eq!(not_accepted.outcome_class, DispatchOutcomeClass::NotAccepted);
        assert!(not_accepted.retry_safe);

        let unknown = classify_post_dispatch_outcome(&PostDispatchInput {
            http_status: Some(200),
            bytes_received: 42,
            upstream_accepted: true,
            terminal_received: false,
            stream_dropped: true,
            ..Default::default()
        });
        assert_eq!(unknown.outcome_class, DispatchOutcomeClass::Unknown);
        assert_eq!(
            unknown.reservation_status,
            ReservationStatus::OperatorRecoveryRequired
        );
        assert!(unknown.blocks_auto_retry);
        assert!(!unknown.retry_safe);

        let accepted = classify_post_dispatch_outcome(&PostDispatchInput {
            http_status: Some(200),
            bytes_received: 512,
            upstream_accepted: true,
            terminal_received: true,
            stream_dropped: false,
            ..Default::default()
        });
        assert_eq!(accepted.outcome_class, DispatchOutcomeClass::Accepted);
        assert_eq!(
            accepted.reservation_status,
            ReservationStatus::ReconciledCharged
        );
    }
}
