use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    error::{NativeError, NativeResult, ProviderErrorClass},
    storage::{now_ms, Storage},
};

pub const RUN_EVENT_SCHEMA_VERSION: i64 = 1;
pub const RUN_JOURNAL_CURSOR_SCHEMA_VERSION: u32 = 1;
pub const MAX_RUN_EVENT_PAYLOAD_BYTES: usize = 512 * 1024;
pub const MAX_RUN_EVENT_REPLAY_PAGE_SIZE: u32 = 1_000;
pub const MAX_RUN_EVENT_REPLAY_PAGE_BYTES: usize = 4 * 1024 * 1024;

const DEFAULT_PROFILE_ID: &str = "profile_default";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunEventKind {
    RunCreated,
    RunDispatching,
    AttemptDispatchStarted,
    AttemptCreated,
    AttemptAccepted,
    RunStarted,
    MessageTextDelta,
    MessageReasoningSummaryDelta,
    UsageUpdated,
    AttemptCompleted,
    AttemptInterrupted,
    AttemptFailed,
    AttemptOutcomeUnknown,
    RunCompleted,
    RunCancelled,
    RunFailed,
    RunRecovered,
    /// Immutable retrieval/context admission receipt.  The payload contains
    /// only bounded chunk identifiers, scores and policy facts; source text is
    /// deliberately excluded from the journal.
    ContextRetrievalReceipt,
}

impl RunEventKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RunCreated => "run.created",
            Self::RunDispatching => "run.dispatching",
            Self::AttemptDispatchStarted => "attempt.dispatch_started",
            Self::AttemptCreated => "attempt.created",
            Self::AttemptAccepted => "attempt.accepted",
            Self::RunStarted => "run.started",
            Self::MessageTextDelta => "message.text_delta",
            Self::MessageReasoningSummaryDelta => "message.reasoning_summary_delta",
            Self::UsageUpdated => "usage.updated",
            Self::AttemptCompleted => "attempt.completed",
            Self::AttemptInterrupted => "attempt.interrupted",
            Self::AttemptFailed => "attempt.failed",
            Self::AttemptOutcomeUnknown => "attempt.outcome_unknown",
            Self::RunCompleted => "run.completed",
            Self::RunCancelled => "run.cancelled",
            Self::RunFailed => "run.failed",
            Self::RunRecovered => "run.recovered",
            Self::ContextRetrievalReceipt => "context.retrieval_receipt",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        Some(match value {
            "run.created" => Self::RunCreated,
            "run.dispatching" => Self::RunDispatching,
            "attempt.dispatch_started" => Self::AttemptDispatchStarted,
            "attempt.created" => Self::AttemptCreated,
            "attempt.accepted" => Self::AttemptAccepted,
            "run.started" => Self::RunStarted,
            "message.text_delta" => Self::MessageTextDelta,
            "message.reasoning_summary_delta" => Self::MessageReasoningSummaryDelta,
            "usage.updated" => Self::UsageUpdated,
            "attempt.completed" => Self::AttemptCompleted,
            "attempt.interrupted" => Self::AttemptInterrupted,
            "attempt.failed" => Self::AttemptFailed,
            "attempt.outcome_unknown" => Self::AttemptOutcomeUnknown,
            "run.completed" => Self::RunCompleted,
            "run.cancelled" => Self::RunCancelled,
            "run.failed" => Self::RunFailed,
            "run.recovered" => Self::RunRecovered,
            "context.retrieval_receipt" => Self::ContextRetrievalReceipt,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderAcceptanceEvidence {
    NotAccepted,
    Accepted,
    Unknown,
}

impl ProviderAcceptanceEvidence {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderAttemptFailureEvidence {
    Definitive {
        acceptance: ProviderAcceptanceEvidence,
    },
    OutcomeUnknown {
        acceptance: ProviderAcceptanceEvidence,
    },
}

impl ProviderAttemptFailureEvidence {
    fn validate(self) -> NativeResult<Self> {
        match self {
            Self::Definitive {
                acceptance: ProviderAcceptanceEvidence::Unknown,
            } => Err(NativeError::new(
                "provider_evidence_conflict",
                "A definitive provider failure cannot carry unknown acceptance evidence",
            )),
            Self::OutcomeUnknown {
                acceptance: ProviderAcceptanceEvidence::NotAccepted,
            } => Err(NativeError::new(
                "provider_evidence_conflict",
                "An outcome-unknown attempt cannot claim that the provider definitely did not accept it",
            )),
            evidence => Ok(evidence),
        }
    }

    const fn attempt_state(self) -> &'static str {
        match self {
            Self::Definitive { .. } => "failed",
            Self::OutcomeUnknown { .. } => "outcome_unknown",
        }
    }

    const fn event_kind(self) -> RunEventKind {
        match self {
            Self::Definitive { .. } => RunEventKind::AttemptFailed,
            Self::OutcomeUnknown { .. } => RunEventKind::AttemptOutcomeUnknown,
        }
    }

    const fn acceptance(self) -> ProviderAcceptanceEvidence {
        match self {
            Self::Definitive { acceptance } | Self::OutcomeUnknown { acceptance } => acceptance,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunEventSource {
    Harness,
    Provider,
}

impl RunEventSource {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Harness => "harness",
            Self::Provider => "provider",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[allow(dead_code)] // Diagnostic is part of the persisted visibility vocabulary
pub enum RunEventVisibility {
    User,
    Inspector,
    Diagnostic,
}

impl RunEventVisibility {
    const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Inspector => "inspector",
            Self::Diagnostic => "diagnostic",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunEventSensitivity {
    Normal,
}

impl RunEventSensitivity {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
        }
    }
}

pub struct AppendRunEvent<'a> {
    pub run_id: &'a str,
    pub attempt_id: Option<&'a str>,
    pub frozen_provider_input_id: Option<&'a str>,
    pub kind: RunEventKind,
    pub source: RunEventSource,
    pub visibility: RunEventVisibility,
    pub sensitivity: RunEventSensitivity,
    pub payload: Value,
    pub occurred_at_ms: i64,
}

/// Redacted, bounded retrieval evidence attached to a run journal.  This is
/// intentionally independent of the workspace indexer DTO so that other
/// retrieval connectors can emit the same receipt without copying source
/// content into durable run history.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunContextRetrievalReceipt {
    pub query_sha256: String,
    pub index_snapshot_id: Option<String>,
    pub index_snapshot_sha256: Option<String>,
    pub indexer_version: String,
    pub scorer_version: String,
    pub token_budget: u64,
    pub consumed_tokens: u64,
    pub matched_candidates: u64,
    pub omission_report_truncated: bool,
    pub matches: Vec<RunContextRetrievalMatch>,
    pub omissions: Vec<RunContextRetrievalOmission>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunContextRetrievalMatch {
    pub chunk_id: String,
    pub source_id: String,
    pub rank: u32,
    pub score: f64,
    pub reasons: Vec<String>,
    pub token_estimate: u64,
    pub content_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunContextRetrievalOmission {
    pub chunk_id: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunJournalCursor {
    pub schema_version: u32,
    pub run_id: String,
    pub journal_epoch: String,
    pub sequence: i64,
    pub event_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunJournalEventRecord {
    pub schema_version: i64,
    pub id: String,
    pub run_id: String,
    pub journal_epoch: String,
    pub attempt_id: Option<String>,
    pub frozen_provider_input_id: Option<String>,
    pub sequence: i64,
    pub event_type: String,
    pub source: String,
    pub visibility: String,
    pub sensitivity: String,
    pub payload: Value,
    pub occurred_at_ms: i64,
    pub committed_at_ms: i64,
}

impl RunJournalEventRecord {}

#[derive(Clone, Debug)]
pub struct PreparedRunJournalScope {
    pub run_id: String,
    pub attempt_id: String,
    pub frozen_provider_input_id: String,
}

impl PreparedRunJournalScope {
    pub fn new(
        run_id: impl Into<String>,
        attempt_id: impl Into<String>,
        frozen_provider_input_id: impl Into<String>,
    ) -> NativeResult<Self> {
        let scope = Self {
            run_id: run_id.into(),
            attempt_id: attempt_id.into(),
            frozen_provider_input_id: frozen_provider_input_id.into(),
        };
        validate_prefixed_id("runId", &scope.run_id, "run_")?;
        validate_prefixed_id("attemptId", &scope.attempt_id, "attempt_")?;
        validate_prefixed_id(
            "frozenProviderInputId",
            &scope.frozen_provider_input_id,
            "provider_input_",
        )?;
        Ok(scope)
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ProviderUsageSnapshot {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// Compatibility aggregate retained for the legacy assistant-message
    /// projection.  New provider adapters should populate the explicit
    /// read/write fields below whenever the wire protocol distinguishes them.
    pub cached_input_tokens: Option<u64>,
    /// Input tokens read from a provider-native prompt/context cache.
    pub cache_read_input_tokens: Option<u64>,
    /// Input tokens written to a provider-native prompt/context cache.
    pub cache_write_input_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadRunJournalRequest {
    pub run_id: String,
    pub journal_epoch: Option<String>,
    pub after_sequence: Option<i64>,
    pub after_event_id: Option<String>,
    pub through_sequence: Option<i64>,
    pub through_event_id: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Clone, Copy, Debug)]
struct ValidatedReplayWindow {
    after_sequence: i64,
    through_sequence: Option<i64>,
    limit: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunJournalReplayPage {
    pub run_id: String,
    pub journal_epoch: String,
    pub coverage: String,
    pub coverage_reason: Option<String>,
    pub events: Vec<RunJournalEventRecord>,
    pub next_cursor: RunJournalCursor,
    pub through_cursor: RunJournalCursor,
    pub complete: bool,
}

impl Storage {
    pub fn journal_provider_started(
        &self,
        scope: &PreparedRunJournalScope,
        provider_profile_id: &str,
        model_id: &str,
        occurred_at_ms: i64,
    ) -> NativeResult<Vec<RunJournalEventRecord>> {
        self.with_transaction(|transaction| {
            assert_prepared_scope_state(transaction, scope, &["dispatching", "accepted"])?;
            let attempt_updated = transaction.execute(
                "UPDATE run_attempts
                 SET state = 'streaming', accepted_by_provider = 'true'
                 WHERE id = ?1 AND generation_id = ?2
                   AND provider_profile_id = ?3 AND model_id = ?4
                   AND state IN ('dispatching', 'accepted')",
                params![
                    scope.attempt_id,
                    scope.run_id,
                    provider_profile_id,
                    model_id
                ],
            )?;
            if attempt_updated != 1 {
                return Err(NativeError::new(
                    "run_state_conflict",
                    "The exact provider attempt was not ready to stream",
                ));
            }
            let accepted = append_run_event(
                transaction,
                provider_event(
                    &scope.run_id,
                    &scope.attempt_id,
                    &scope.frozen_provider_input_id,
                    RunEventKind::AttemptAccepted,
                    json!({
                        "providerProfileId": provider_profile_id,
                        "model": model_id,
                    }),
                    occurred_at_ms,
                ),
            )?;
            let started = append_run_event(
                transaction,
                provider_event(
                    &scope.run_id,
                    &scope.attempt_id,
                    &scope.frozen_provider_input_id,
                    RunEventKind::RunStarted,
                    json!({
                        "providerProfileId": provider_profile_id,
                        "model": model_id,
                    }),
                    occurred_at_ms,
                ),
            )?;
            Ok(vec![accepted, started])
        })
    }

    pub fn journal_assistant_delta(
        &self,
        scope: &PreparedRunJournalScope,
        text: &str,
        occurred_at_ms: i64,
    ) -> NativeResult<Option<RunJournalEventRecord>> {
        if text.is_empty() {
            return Ok(None);
        }
        if text.len() > crate::storage::MAX_MESSAGE_BYTES {
            return Err(NativeError::invalid(
                "text",
                "exceeds the message safety limit",
            ));
        }
        self.with_transaction(|transaction| {
            assert_prepared_scope_state(transaction, scope, &["streaming"])?;
            let updated = transaction.execute(
                "UPDATE messages
                 SET content_text = content_text || ?1, updated_at_ms = ?2
                 WHERE id = (
                     SELECT assistant_message_id FROM generations WHERE id = ?3
                 )
                   AND status = 'draft'
                   AND length(CAST(content_text AS BLOB)) + length(CAST(?1 AS BLOB)) <= ?4",
                params![
                    text,
                    occurred_at_ms,
                    scope.run_id,
                    crate::storage::MAX_MESSAGE_BYTES as i64
                ],
            )?;
            if updated != 1 {
                return Err(NativeError::new(
                    "message_projection_failed",
                    "The assistant projection is missing, finalized, or too large",
                ));
            }
            append_run_event(
                transaction,
                provider_event(
                    &scope.run_id,
                    &scope.attempt_id,
                    &scope.frozen_provider_input_id,
                    RunEventKind::MessageTextDelta,
                    json!({ "text": text }),
                    occurred_at_ms,
                ),
            )
            .map(Some)
        })
    }

    pub fn journal_reasoning_delta(
        &self,
        scope: &PreparedRunJournalScope,
        text: &str,
        occurred_at_ms: i64,
    ) -> NativeResult<Option<RunJournalEventRecord>> {
        if text.is_empty() {
            return Ok(None);
        }
        if text.len() > MAX_RUN_EVENT_PAYLOAD_BYTES {
            return Err(NativeError::invalid(
                "text",
                "exceeds the reasoning-event safety limit",
            ));
        }
        self.with_transaction(|transaction| {
            assert_prepared_scope_state(transaction, scope, &["streaming"])?;
            append_run_event(
                transaction,
                provider_event(
                    &scope.run_id,
                    &scope.attempt_id,
                    &scope.frozen_provider_input_id,
                    RunEventKind::MessageReasoningSummaryDelta,
                    json!({ "text": text }),
                    occurred_at_ms,
                ),
            )
            .map(Some)
        })
    }

    pub fn journal_usage(
        &self,
        scope: &PreparedRunJournalScope,
        usage: ProviderUsageSnapshot,
        occurred_at_ms: i64,
    ) -> NativeResult<RunJournalEventRecord> {
        let to_i64 = |field: &'static str, value: Option<u64>| -> NativeResult<Option<i64>> {
            value
                .map(|value| {
                    i64::try_from(value)
                        .map_err(|_| NativeError::invalid(field, "exceeds SQLite integer range"))
                })
                .transpose()
        };
        let input_tokens = to_i64("inputTokens", usage.input_tokens)?;
        let output_tokens = to_i64("outputTokens", usage.output_tokens)?;
        let cache_read_input_tokens = to_i64(
            "cacheReadInputTokens",
            usage.cache_read_input_tokens.or(usage.cached_input_tokens),
        )?;
        let cache_write_input_tokens =
            to_i64("cacheWriteInputTokens", usage.cache_write_input_tokens)?;
        // Keep the old message-level projection useful for providers which
        // expose a single cache counter, while preserving the provider's
        // separate read/write facts in the attempt-scoped ledger.
        let cached_input_tokens = to_i64(
            "cachedInputTokens",
            usage.cached_input_tokens.or_else(|| {
                match (
                    usage.cache_read_input_tokens,
                    usage.cache_write_input_tokens,
                ) {
                    (Some(read), Some(write)) => read.checked_add(write),
                    (Some(read), None) => Some(read),
                    (None, Some(write)) => Some(write),
                    (None, None) => None,
                }
            }),
        )?;
        let reasoning_tokens = to_i64("reasoningTokens", usage.reasoning_tokens)?;
        self.with_transaction(|transaction| {
            assert_prepared_scope_state(transaction, scope, &["streaming"])?;

            // Keep the old message-level columns as a compatibility projection,
            // but make the attempt-scoped usage ledger the durable accounting
            // source. The ledger row, projection mutation, and journal fact must
            // either all commit or all roll back together.
            let updated = transaction.execute(
                "UPDATE messages
                 SET input_tokens = CASE
                       WHEN ?1 IS NULL THEN input_tokens
                       ELSE MAX(COALESCE(input_tokens, 0), ?1)
                     END,
                     output_tokens = CASE
                       WHEN ?2 IS NULL THEN output_tokens
                       ELSE MAX(COALESCE(output_tokens, 0), ?2)
                     END,
                     cached_tokens = CASE
                       WHEN ?3 IS NULL THEN cached_tokens
                       ELSE MAX(COALESCE(cached_tokens, 0), ?3)
                     END,
                     reasoning_tokens = CASE
                       WHEN ?4 IS NULL THEN reasoning_tokens
                       ELSE MAX(COALESCE(reasoning_tokens, 0), ?4)
                     END,
                     updated_at_ms = ?5
                 WHERE id = (
                     SELECT assistant_message_id FROM generations WHERE id = ?6
                 ) AND status = 'draft'",
                params![
                    input_tokens,
                    output_tokens,
                    cached_input_tokens,
                    reasoning_tokens,
                    occurred_at_ms,
                    scope.run_id
                ],
            )?;
            if updated != 1 {
                return Err(NativeError::new(
                    "message_projection_failed",
                    "The assistant projection is missing or already finalized",
                ));
            }

            let profile_id: String = transaction.query_row(
                "SELECT c.profile_id
                 FROM generations g
                 JOIN conversations c ON c.id = g.conversation_id
                 WHERE g.id = ?1",
                [scope.run_id.as_str()],
                |row| row.get(0),
            )?;
            let ledger_sequence: i64 = transaction.query_row(
                "SELECT COALESCE(MAX(sequence_no), 0) + 1
                 FROM run_usage_ledger
                 WHERE attempt_id = ?1",
                [scope.attempt_id.as_str()],
                |row| row.get(0),
            )?;
            let usage_entry_id = format!("usage_ledger_entry_{}", Uuid::new_v4().simple());

            // A streaming adapter may not expose a provider-owned event ID. In
            // that case, create a content-free identity from the exact frozen
            // attempt and monotonic per-attempt observation number. It is never
            // a raw provider payload or a prompt/response fingerprint, and it
            // lets the ledger retain immutable provenance for each observation.
            let response_identity_hash = crate::storage::sha256_hex(
                serde_json::to_vec(&json!({
                    "schemaVersion": 1,
                    "kind": "provider-stream-usage",
                    "runId": scope.run_id,
                    "attemptId": scope.attempt_id,
                    "frozenProviderInputId": scope.frozen_provider_input_id,
                    "sequence": ledger_sequence,
                    "observedAtMs": occurred_at_ms,
                    "counters": {
                        "inputTokens": usage.input_tokens,
                        "cacheReadInputTokens": usage
                            .cache_read_input_tokens
                            .or(usage.cached_input_tokens),
                        "cacheWriteInputTokens": usage.cache_write_input_tokens,
                        "outputTokens": usage.output_tokens,
                        "reasoningTokens": usage.reasoning_tokens,
                    },
                }))
                .map_err(|_| {
                    NativeError::new(
                        "telemetry_serialization_failed",
                        "The provider usage identity could not be serialized",
                    )
                })?,
            );
            let fact_sha256 = crate::storage::sha256_hex(
                serde_json::to_vec(&json!({
                    "source": "provider-incremental",
                    "authoritative": false,
                    "coverage": "partial",
                    "observedAtMs": occurred_at_ms,
                    "responseIdentityHash": response_identity_hash,
                    "counters": {
                        "inputTokens": usage.input_tokens,
                        "cacheReadInputTokens": usage
                            .cache_read_input_tokens
                            .or(usage.cached_input_tokens),
                        "cacheWriteInputTokens": usage.cache_write_input_tokens,
                        "outputTokens": usage.output_tokens,
                        "reasoningTokens": usage.reasoning_tokens,
                        "visibleOutputTokens": Value::Null,
                    },
                    "providerCounters": {},
                    "costs": [],
                    "supersedesEntryId": Value::Null,
                }))
                .map_err(|_| {
                    NativeError::new(
                        "telemetry_serialization_failed",
                        "The provider usage fact could not be serialized",
                    )
                })?,
            );
            transaction.execute(
                "INSERT INTO run_usage_ledger (
                    id, schema_version, profile_id, run_id, attempt_id, sequence_no,
                    source, authoritative, coverage, observed_at_ms,
                    response_identity_hash, fact_sha256,
                    input_tokens, cache_read_input_tokens, cache_write_input_tokens,
                    output_tokens, reasoning_tokens, visible_output_tokens,
                    provider_counters_json, supersedes_entry_id, created_at_ms
                 ) VALUES (?1, 1, ?2, ?3, ?4, ?5, 'provider-incremental', 0, 'partial', ?6,
                           ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, '{}', NULL, ?14)",
                params![
                    usage_entry_id,
                    profile_id,
                    scope.run_id,
                    scope.attempt_id,
                    ledger_sequence,
                    occurred_at_ms,
                    response_identity_hash,
                    fact_sha256,
                    input_tokens,
                    cache_read_input_tokens,
                    cache_write_input_tokens,
                    output_tokens,
                    reasoning_tokens,
                    now_ms(),
                ],
            )?;

            append_run_event(
                transaction,
                provider_event(
                    &scope.run_id,
                    &scope.attempt_id,
                    &scope.frozen_provider_input_id,
                    RunEventKind::UsageUpdated,
                    json!({
                        "usageEntryId": usage_entry_id,
                        "source": "provider-incremental",
                        "coverage": "partial",
                        "inputTokens": usage.input_tokens,
                        "outputTokens": usage.output_tokens,
                        "cachedInputTokens": usage.cached_input_tokens,
                        "cacheReadInputTokens": usage
                            .cache_read_input_tokens
                            .or(usage.cached_input_tokens),
                        "cacheWriteInputTokens": usage.cache_write_input_tokens,
                        "reasoningTokens": usage.reasoning_tokens,
                    }),
                    occurred_at_ms,
                ),
            )
        })
    }

    pub fn journal_run_completed(
        &self,
        scope: &PreparedRunJournalScope,
        finish_reason: &str,
        occurred_at_ms: i64,
    ) -> NativeResult<Vec<RunJournalEventRecord>> {
        let finish_reason = validate_bounded_text("finishReason", finish_reason, 120)?;
        let cancelled = finish_reason == "cancelled";
        self.with_transaction(|transaction| {
            assert_prepared_scope_state(
                transaction,
                scope,
                &["dispatching", "accepted", "streaming"],
            )?;
            let assistant_message_id: String = transaction
                .query_row(
                    "SELECT assistant_message_id FROM generations WHERE id = ?1",
                    [scope.run_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| NativeError::new("run_not_found", "The run no longer exists"))?;
            let content: String = transaction.query_row(
                "SELECT content_text FROM messages WHERE id = ?1",
                [&assistant_message_id],
                |row| row.get(0),
            )?;
            let content_json = json!([{ "type": "text", "text": &content }]).to_string();
            let content_hash = crate::storage::sha256_hex(content.as_bytes());
            let message_status = if cancelled { "cancelled" } else { "complete" };
            let run_state = if cancelled { "cancelled" } else { "complete" };
            let attempt_state = if cancelled { "interrupted" } else { "complete" };
            let message_updated = transaction.execute(
                "UPDATE messages
                 SET status = ?1, content_json = ?2, content_sha256 = ?3,
                     finish_reason = ?4, updated_at_ms = ?5, finalized_at_ms = ?5
                 WHERE id = ?6 AND status = 'draft'",
                params![
                    message_status,
                    content_json,
                    content_hash,
                    finish_reason,
                    occurred_at_ms,
                    assistant_message_id
                ],
            )?;
            let run_updated = transaction.execute(
                "UPDATE generations
                 SET state = ?1, completed_at_ms = ?2
                 WHERE id = ?3 AND state = 'running'",
                params![run_state, occurred_at_ms, scope.run_id],
            )?;
            let attempt_updated = transaction.execute(
                "UPDATE run_attempts
                 SET state = ?1, completed_at_ms = ?2
                 WHERE id = ?3 AND generation_id = ?4
                   AND state IN ('dispatching', 'accepted', 'streaming')",
                params![
                    attempt_state,
                    occurred_at_ms,
                    scope.attempt_id,
                    scope.run_id
                ],
            )?;
            if message_updated != 1 || run_updated != 1 || attempt_updated != 1 {
                return Err(NativeError::new(
                    "run_graph_conflict",
                    "The exact run graph was not in a completable state",
                ));
            }

            let attempt_kind = if cancelled {
                RunEventKind::AttemptInterrupted
            } else {
                RunEventKind::AttemptCompleted
            };
            let run_kind = if cancelled {
                RunEventKind::RunCancelled
            } else {
                RunEventKind::RunCompleted
            };
            let attempt_event = append_run_event(
                transaction,
                provider_event(
                    &scope.run_id,
                    &scope.attempt_id,
                    &scope.frozen_provider_input_id,
                    attempt_kind,
                    json!({ "finishReason": finish_reason }),
                    occurred_at_ms,
                ),
            )?;
            let run_event = append_run_event(
                transaction,
                provider_event(
                    &scope.run_id,
                    &scope.attempt_id,
                    &scope.frozen_provider_input_id,
                    run_kind,
                    json!({ "finishReason": finish_reason }),
                    occurred_at_ms,
                ),
            )?;
            Ok(vec![attempt_event, run_event])
        })
    }

    // Thin compatibility wrapper over `journal_run_failed_with_class`; only the
    // legacy `fail_run*` helpers call it, so non-test builds do not use it.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn journal_run_failed(
        &self,
        scope: &PreparedRunJournalScope,
        error_code: &str,
        evidence: ProviderAttemptFailureEvidence,
        occurred_at_ms: i64,
    ) -> NativeResult<Vec<RunJournalEventRecord>> {
        self.journal_run_failed_with_class(scope, error_code, None, evidence, occurred_at_ms)
    }

    pub fn journal_run_failed_with_class(
        &self,
        scope: &PreparedRunJournalScope,
        error_code: &str,
        error_class: Option<ProviderErrorClass>,
        evidence: ProviderAttemptFailureEvidence,
        occurred_at_ms: i64,
    ) -> NativeResult<Vec<RunJournalEventRecord>> {
        let error_code = validate_bounded_text("errorCode", error_code, 120)?;
        let evidence = evidence.validate()?;
        self.with_transaction(|transaction| {
            let allowed_attempt_states = match evidence {
                ProviderAttemptFailureEvidence::Definitive {
                    acceptance: ProviderAcceptanceEvidence::NotAccepted,
                } => vec!["created", "dispatching", "accepted", "streaming"],
                ProviderAttemptFailureEvidence::Definitive { .. }
                | ProviderAttemptFailureEvidence::OutcomeUnknown { .. } => {
                    vec!["dispatching", "accepted", "streaming"]
                }
            };
            assert_prepared_scope_state_with_run_states(
                transaction,
                scope,
                &allowed_attempt_states,
                &["queued", "running"],
            )?;
            let current_acceptance: String = transaction.query_row(
                "SELECT accepted_by_provider
                 FROM run_attempts
                 WHERE id = ?1 AND generation_id = ?2",
                params![scope.attempt_id, scope.run_id],
                |row| row.get(0),
            )?;
            let accepted = merge_acceptance_evidence(&current_acceptance, evidence.acceptance())?;
            let assistant_message_id: String = transaction
                .query_row(
                    "SELECT assistant_message_id FROM generations WHERE id = ?1",
                    [scope.run_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| NativeError::new("run_not_found", "The run no longer exists"))?;
            let content: String = transaction.query_row(
                "SELECT content_text FROM messages WHERE id = ?1",
                [&assistant_message_id],
                |row| row.get(0),
            )?;
            let content_json = json!([{ "type": "text", "text": &content }]).to_string();
            let content_hash = crate::storage::sha256_hex(content.as_bytes());
            let attempt_state = evidence.attempt_state();
            let message_updated = transaction.execute(
                "UPDATE messages
                 SET status = 'failed', content_json = ?1, content_sha256 = ?2,
                     updated_at_ms = ?3, finalized_at_ms = ?3
                 WHERE id = ?4 AND status = 'draft'",
                params![
                    content_json,
                    content_hash,
                    occurred_at_ms,
                    assistant_message_id
                ],
            )?;
            let run_updated = transaction.execute(
                "UPDATE generations
                 SET state = 'failed', error_code = ?1, completed_at_ms = ?2
                 WHERE id = ?3 AND state IN ('queued', 'running')",
                params![error_code, occurred_at_ms, scope.run_id],
            )?;
            let attempt_updated = transaction.execute(
                "UPDATE run_attempts
                 SET state = ?1, accepted_by_provider = ?2, error_code = ?3,
                     completed_at_ms = ?4
                 WHERE id = ?5 AND generation_id = ?6
                   AND state IN ('created', 'dispatching', 'accepted', 'streaming')",
                params![
                    attempt_state,
                    accepted,
                    error_code,
                    occurred_at_ms,
                    scope.attempt_id,
                    scope.run_id
                ],
            )?;
            if message_updated != 1 || run_updated != 1 || attempt_updated != 1 {
                return Err(NativeError::new(
                    "run_graph_conflict",
                    "The exact run graph was not in a fail-able state",
                ));
            }
            let attempt_event = append_run_event(
                transaction,
                provider_event(
                    &scope.run_id,
                    &scope.attempt_id,
                    &scope.frozen_provider_input_id,
                    evidence.event_kind(),
                    failure_attempt_payload(error_code, accepted, None, error_class),
                    occurred_at_ms,
                ),
            )?;
            let run_event = append_run_event(
                transaction,
                provider_event(
                    &scope.run_id,
                    &scope.attempt_id,
                    &scope.frozen_provider_input_id,
                    RunEventKind::RunFailed,
                    failure_payload_with_class(error_code, error_class),
                    occurred_at_ms,
                ),
            )?;
            Ok(vec![attempt_event, run_event])
        })
    }

    /// Terminalizes a prepared run that failed before the provider request was
    /// dispatched. This is deliberately separate from `journal_run_failed`:
    /// the normal provider path requires a running generation, while a
    /// pre-dispatch failure still has a queued generation and a created
    /// attempt. Keeping the two transitions explicit prevents a malformed
    /// request from being mistaken for an accepted provider call.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn journal_prepared_run_failed(
        &self,
        scope: &PreparedRunJournalScope,
        error_code: &str,
        evidence: ProviderAttemptFailureEvidence,
        occurred_at_ms: i64,
    ) -> NativeResult<Vec<RunJournalEventRecord>> {
        self.journal_prepared_run_failed_with_class(
            scope,
            error_code,
            None,
            evidence,
            occurred_at_ms,
        )
    }

    pub fn journal_prepared_run_failed_with_class(
        &self,
        scope: &PreparedRunJournalScope,
        error_code: &str,
        error_class: Option<ProviderErrorClass>,
        evidence: ProviderAttemptFailureEvidence,
        occurred_at_ms: i64,
    ) -> NativeResult<Vec<RunJournalEventRecord>> {
        let error_code = validate_bounded_text("errorCode", error_code, 120)?;
        let evidence = evidence.validate()?;
        if evidence.acceptance() != ProviderAcceptanceEvidence::NotAccepted
            || evidence.attempt_state() != "failed"
        {
            return Err(NativeError::new(
                "provider_evidence_conflict",
                "A pre-dispatch failure must be definitive and not accepted",
            ));
        }
        self.with_transaction(|transaction| {
            let exact_scope: Option<(String, String)> = transaction
                .query_row(
                    "SELECT g.state, a.state
                     FROM run_attempts a
                     JOIN generations g ON g.id = a.generation_id
                     JOIN frozen_provider_inputs f ON f.attempt_id = a.id
                     WHERE a.id = ?1 AND a.generation_id = ?2
                       AND f.id = ?3 AND f.run_id = ?2
                       AND g.id = ?2",
                    params![
                        scope.attempt_id,
                        scope.run_id,
                        scope.frozen_provider_input_id
                    ],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((run_state, attempt_state)) = exact_scope else {
                return Err(NativeError::new(
                    "run_event_scope_conflict",
                    "The exact run, attempt, and frozen input do not belong together",
                ));
            };
            if run_state != "queued" || attempt_state != "created" {
                return Err(NativeError::new(
                    "run_state_conflict",
                    "The prepared run is no longer in its pre-dispatch state",
                ));
            }

            let assistant_message_id: String = transaction
                .query_row(
                    "SELECT assistant_message_id FROM generations WHERE id = ?1",
                    [scope.run_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| NativeError::new("run_not_found", "The run no longer exists"))?;
            let content: String = transaction.query_row(
                "SELECT content_text FROM messages WHERE id = ?1",
                [&assistant_message_id],
                |row| row.get(0),
            )?;
            let content_json = json!([{ "type": "text", "text": &content }]).to_string();
            let content_hash = crate::storage::sha256_hex(content.as_bytes());
            let message_updated = transaction.execute(
                "UPDATE messages
                 SET status = 'failed', content_json = ?1, content_sha256 = ?2,
                     updated_at_ms = ?3, finalized_at_ms = ?3
                 WHERE id = ?4 AND status = 'draft'",
                params![
                    content_json,
                    content_hash,
                    occurred_at_ms,
                    assistant_message_id
                ],
            )?;
            let run_updated = transaction.execute(
                "UPDATE generations
                 SET state = 'failed', error_code = ?1, completed_at_ms = ?2
                 WHERE id = ?3 AND state = 'queued'",
                params![error_code, occurred_at_ms, scope.run_id],
            )?;
            let attempt_updated = transaction.execute(
                "UPDATE run_attempts
                 SET state = 'failed', accepted_by_provider = 'false',
                     error_code = ?1, completed_at_ms = ?2
                 WHERE id = ?3 AND generation_id = ?4 AND state = 'created'",
                params![error_code, occurred_at_ms, scope.attempt_id, scope.run_id],
            )?;
            if message_updated != 1 || run_updated != 1 || attempt_updated != 1 {
                return Err(NativeError::new(
                    "run_graph_conflict",
                    "The prepared run changed before its pre-dispatch failure could be recorded",
                ));
            }

            let attempt_event = append_run_event(
                transaction,
                provider_event(
                    &scope.run_id,
                    &scope.attempt_id,
                    &scope.frozen_provider_input_id,
                    RunEventKind::AttemptFailed,
                    failure_attempt_payload(error_code, "false", Some("pre_dispatch"), error_class),
                    occurred_at_ms,
                ),
            )?;
            let run_event = append_run_event(
                transaction,
                provider_event(
                    &scope.run_id,
                    &scope.attempt_id,
                    &scope.frozen_provider_input_id,
                    RunEventKind::RunFailed,
                    failure_payload_with_class(error_code, error_class),
                    occurred_at_ms,
                ),
            )?;
            Ok(vec![attempt_event, run_event])
        })
    }

    pub fn read_run_journal(
        &self,
        request: &ReadRunJournalRequest,
    ) -> NativeResult<RunJournalReplayPage> {
        let replay = validate_read_request(request)?;

        self.with_connection(|connection| {
            let journal = connection
                .query_row(
                    "SELECT j.journal_epoch, j.coverage, j.coverage_reason,
                            COALESCE(MAX(e.sequence_no), 0)
                     FROM run_journals j
                     JOIN generations g ON g.id = j.run_id
                     JOIN conversations c ON c.id = g.conversation_id
                     LEFT JOIN run_events e ON e.run_id = j.run_id
                     WHERE j.run_id = ?1 AND c.profile_id = ?2
                     GROUP BY j.run_id, j.journal_epoch, j.coverage, j.coverage_reason",
                    params![request.run_id, DEFAULT_PROFILE_ID],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )
                .optional()?;
            let (journal_epoch, coverage, coverage_reason, head_sequence) =
                journal.ok_or_else(|| {
                    NativeError::new(
                        "run_journal_not_found",
                        "The requested run journal does not exist in this profile",
                    )
                })?;
            if request
                .journal_epoch
                .as_deref()
                .is_some_and(|expected| expected != journal_epoch)
            {
                return Err(cursor_conflict());
            }

            validate_cursor_identity(
                connection,
                &request.run_id,
                replay.after_sequence,
                request.after_event_id.as_deref(),
            )?;
            let through_sequence = replay.through_sequence.unwrap_or(head_sequence);
            if through_sequence > head_sequence || replay.after_sequence > through_sequence {
                return Err(NativeError::new(
                    "run_journal_cursor_conflict",
                    "The requested replay window does not match the durable journal",
                ));
            }
            if replay.through_sequence.is_some() {
                validate_cursor_identity(
                    connection,
                    &request.run_id,
                    through_sequence,
                    request.through_event_id.as_deref(),
                )?;
            }

            let mut statement = connection.prepare(
                "SELECT e.schema_version, e.id, e.run_id, e.attempt_id,
                        frozen_provider_input_id, sequence_no, event_type,
                        source, visibility, sensitivity, payload_json,
                        occurred_at_ms, committed_at_ms, j.journal_epoch
                 FROM run_events e
                 JOIN run_journals j ON j.run_id = e.run_id
                 WHERE e.run_id = ?1 AND sequence_no > ?2 AND sequence_no <= ?3
                 ORDER BY sequence_no
                 LIMIT ?4",
            )?;
            let rows = statement.query_map(
                params![
                    request.run_id,
                    replay.after_sequence,
                    through_sequence,
                    i64::from(replay.limit)
                ],
                event_from_row,
            )?;
            let mut events = Vec::new();
            let mut serialized_page_bytes = 0usize;
            for (row_index, row) in rows.enumerate() {
                let row_offset = i64::try_from(row_index).map_err(|_| {
                    NativeError::new(
                        "run_journal_sequence_overflow",
                        "The replay row offset exceeds the durable journal sequence range",
                    )
                })?;
                let expected_sequence = replay
                    .after_sequence
                    .checked_add(1)
                    .and_then(|sequence| sequence.checked_add(row_offset))
                    .ok_or_else(|| {
                        NativeError::new(
                            "run_journal_sequence_overflow",
                            "The replay sequence exceeds the durable journal sequence range",
                        )
                    })?;
                let event = row?;
                if event.sequence != expected_sequence {
                    return Err(NativeError::new(
                        "run_journal_sequence_gap",
                        "The durable journal contains a missing or reordered event sequence",
                    ));
                }
                let serialized_event_bytes = serde_json::to_vec(&event)
                    .map_err(|_| {
                        NativeError::new(
                            "run_journal_serialization_failed",
                            "A durable run event could not be serialized for replay",
                        )
                    })?
                    .len();
                let next_page_bytes = serialized_page_bytes
                    .checked_add(serialized_event_bytes)
                    .ok_or_else(|| {
                        NativeError::new(
                            "run_journal_page_too_large",
                            "The replay page exceeded its bounded byte budget",
                        )
                    })?;
                if next_page_bytes > MAX_RUN_EVENT_REPLAY_PAGE_BYTES {
                    if events.is_empty() {
                        return Err(NativeError::new(
                            "run_journal_event_too_large",
                            "A durable run event exceeds the replay page byte budget",
                        ));
                    }
                    break;
                }
                serialized_page_bytes = next_page_bytes;
                events.push(event);
            }
            if events.is_empty() && replay.after_sequence < through_sequence {
                return Err(NativeError::new(
                    "run_journal_sequence_gap",
                    "The durable journal is missing the next event in the replay window",
                ));
            }
            let next_sequence = events
                .last()
                .map_or(replay.after_sequence, |event| event.sequence);
            let next_cursor =
                cursor_at(connection, &request.run_id, &journal_epoch, next_sequence)?;
            let through_cursor = cursor_at(
                connection,
                &request.run_id,
                &journal_epoch,
                through_sequence,
            )?;
            Ok(RunJournalReplayPage {
                run_id: request.run_id.clone(),
                journal_epoch,
                coverage,
                coverage_reason,
                events,
                next_cursor,
                through_cursor,
                complete: next_sequence >= through_sequence,
            })
        })
    }
}

/// Creates the durable journal and its initial lifecycle facts inside the
/// caller's run-preparation transaction. The attempt and frozen input rows must
/// already exist so scope validation can prove the exact dispatch ownership.
///
/// The optional context pointer is generated by native preparation after the
/// selected retrieval has been frozen into the provider input. It is metadata
/// only (IDs, hashes and bounded counts); source text never enters the journal.
pub(crate) fn initialize_prepared_run_journal(
    transaction: &Transaction<'_>,
    scope: &PreparedRunJournalScope,
    provider_profile_id: &str,
    model_id: &str,
    context_admission_pointer: Option<Value>,
    bridge_admission_pointer: Option<Value>,
    occurred_at_ms: i64,
) -> NativeResult<Vec<RunJournalEventRecord>> {
    ensure_run_journal(transaction, &scope.run_id, occurred_at_ms)?;
    let run_created = append_run_event(
        transaction,
        harness_prepared_event(
            scope,
            RunEventKind::RunCreated,
            json!({
                "providerProfileId": provider_profile_id,
                "model": model_id,
            }),
            occurred_at_ms,
        ),
    )?;
    // The bridge plan is a durable preparation fact, not a provider-stage
    // event. Keeping its compact, metadata-only pointer on `attempt.created`
    // avoids inventing a new lifecycle event vocabulary in schema v9 while
    // preserving exact run/attempt/frozen-input correlation for audit replay.
    let mut attempt_created_payload = json!({
        "attemptId": scope.attempt_id,
        "frozenProviderInputId": scope.frozen_provider_input_id,
        "providerProfileId": provider_profile_id,
        "model": model_id,
    });
    if let Some(context_admission_pointer) = context_admission_pointer {
        attempt_created_payload["contextAdmission"] = context_admission_pointer;
    }
    if let Some(bridge_admission_pointer) = bridge_admission_pointer {
        attempt_created_payload["bridgeAdmission"] = bridge_admission_pointer;
    }
    let attempt_created = append_run_event(
        transaction,
        harness_prepared_event(
            scope,
            RunEventKind::AttemptCreated,
            attempt_created_payload,
            occurred_at_ms,
        ),
    )?;
    Ok(vec![run_created, attempt_created])
}

/// Appends the dispatch decision facts inside the exact transaction that moves
/// the run, attempt, and frozen input into their dispatching state. Keeping this
/// helper transaction-free is intentional: callers must roll back the graph
/// transition if either journal append fails.
pub(crate) fn append_prepared_dispatch_started(
    transaction: &Transaction<'_>,
    scope: &PreparedRunJournalScope,
    provider_profile_id: &str,
    model_id: &str,
    frozen_input_sha256: &str,
    occurred_at_ms: i64,
) -> NativeResult<Vec<RunJournalEventRecord>> {
    let run_dispatching = append_run_event(
        transaction,
        harness_prepared_event(
            scope,
            RunEventKind::RunDispatching,
            json!({
                "providerProfileId": provider_profile_id,
                "model": model_id,
            }),
            occurred_at_ms,
        ),
    )?;
    let attempt_dispatch_started = append_run_event(
        transaction,
        harness_prepared_event(
            scope,
            RunEventKind::AttemptDispatchStarted,
            json!({
                "attemptId": scope.attempt_id,
                "frozenProviderInputId": scope.frozen_provider_input_id,
                "frozenInputSha256": frozen_input_sha256,
                "providerProfileId": provider_profile_id,
                "model": model_id,
            }),
            occurred_at_ms,
        ),
    )?;
    Ok(vec![run_dispatching, attempt_dispatch_started])
}

pub fn ensure_run_journal(
    transaction: &Transaction<'_>,
    run_id: &str,
    created_at_ms: i64,
) -> NativeResult<String> {
    validate_prefixed_id("runId", run_id, "run_")?;
    let existing = transaction
        .query_row(
            "SELECT journal_epoch FROM run_journals WHERE run_id = ?1",
            [run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(epoch) = existing {
        return Ok(epoch);
    }
    let journal_epoch = format!("journal_epoch_{}", Uuid::new_v4().simple());
    transaction.execute(
        "INSERT INTO run_journals (
            run_id, schema_version, journal_epoch, coverage, coverage_reason,
            created_at_ms
         ) VALUES (?1, 1, ?2, 'complete', NULL, ?3)",
        params![run_id, journal_epoch, created_at_ms],
    )?;
    Ok(journal_epoch)
}

pub fn append_run_event(
    transaction: &Transaction<'_>,
    input: AppendRunEvent<'_>,
) -> NativeResult<RunJournalEventRecord> {
    validate_prefixed_id("runId", input.run_id, "run_")?;
    if let Some(attempt_id) = input.attempt_id {
        validate_prefixed_id("attemptId", attempt_id, "attempt_")?;
    }
    if let Some(input_id) = input.frozen_provider_input_id {
        validate_prefixed_id("frozenProviderInputId", input_id, "provider_input_")?;
    }
    if input.occurred_at_ms <= 0 {
        return Err(NativeError::invalid(
            "occurredAtMs",
            "must be a positive Unix timestamp",
        ));
    }
    let payload_json = serde_json::to_string(&input.payload)
        .map_err(|_| NativeError::invalid("payload", "could not be serialized as a JSON value"))?;
    if payload_json.len() > MAX_RUN_EVENT_PAYLOAD_BYTES {
        return Err(NativeError::invalid(
            "payload",
            "exceeds the run-event safety limit",
        ));
    }
    if input.kind == RunEventKind::ContextRetrievalReceipt {
        validate_context_retrieval_receipt_payload(&input.payload)?;
    }
    if input.attempt_id.is_some() != input.frozen_provider_input_id.is_some() {
        return Err(NativeError::new(
            "run_event_scope_invalid",
            "Provider run events must bind both the exact attempt and frozen input",
        ));
    }

    let journal_epoch = transaction
        .query_row(
            "SELECT journal_epoch FROM run_journals WHERE run_id = ?1",
            [input.run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| {
            NativeError::new(
                "run_journal_missing",
                "The durable journal must exist before an event can be appended",
            )
        })?;

    if let (Some(attempt_id), Some(provider_input_id)) =
        (input.attempt_id, input.frozen_provider_input_id)
    {
        let scope_matches: bool = transaction.query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM run_attempts a
                JOIN frozen_provider_inputs f ON f.attempt_id = a.id
                WHERE a.id = ?1 AND a.generation_id = ?2
                  AND f.id = ?3 AND f.run_id = ?2
            )",
            params![attempt_id, input.run_id, provider_input_id],
            |row| row.get(0),
        )?;
        if !scope_matches {
            return Err(NativeError::new(
                "run_event_scope_conflict",
                "The run event attempt and frozen input do not belong to this run",
            ));
        }
    }

    validate_event_transition(transaction, input.run_id, input.kind)?;

    let terminal_exists: bool = transaction.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM run_events
            WHERE run_id = ?1
              AND event_type IN ('run.completed', 'run.cancelled', 'run.failed')
        )",
        [input.run_id],
        |row| row.get(0),
    )?;
    let is_terminal_event = matches!(
        input.kind,
        RunEventKind::RunCompleted | RunEventKind::RunCancelled | RunEventKind::RunFailed
    );
    if terminal_exists {
        return Err(NativeError::new(
            "run_journal_terminal",
            "The run journal is already terminal",
        ));
    }
    if is_terminal_event {
        let materialized_state: String = transaction.query_row(
            "SELECT state FROM generations WHERE id = ?1",
            [input.run_id],
            |row| row.get(0),
        )?;
        let state_matches = matches!(
            (input.kind, materialized_state.as_str()),
            (RunEventKind::RunCompleted, "complete")
                | (RunEventKind::RunCancelled, "cancelled")
                | (RunEventKind::RunFailed, "failed")
        );
        if !state_matches {
            return Err(NativeError::new(
                "run_journal_terminal_conflict",
                "The terminal run event does not match the materialized run state",
            ));
        }
    }

    let next_sequence: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(sequence_no), 0) + 1
         FROM run_events WHERE run_id = ?1",
        [input.run_id],
        |row| row.get(0),
    )?;
    let committed_at_ms = now_ms();
    let event_id = format!("run_event_{}", Uuid::new_v4().simple());
    transaction.execute(
        "INSERT INTO run_events (
            id, schema_version, run_id, attempt_id, frozen_provider_input_id,
            sequence_no, event_type, source, visibility, sensitivity,
            payload_json, occurred_at_ms, committed_at_ms
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
         )",
        params![
            event_id,
            RUN_EVENT_SCHEMA_VERSION,
            input.run_id,
            input.attempt_id,
            input.frozen_provider_input_id,
            next_sequence,
            input.kind.as_str(),
            input.source.as_str(),
            input.visibility.as_str(),
            input.sensitivity.as_str(),
            payload_json,
            input.occurred_at_ms,
            committed_at_ms
        ],
    )?;
    Ok(RunJournalEventRecord {
        schema_version: RUN_EVENT_SCHEMA_VERSION,
        id: event_id,
        run_id: input.run_id.to_owned(),
        journal_epoch,
        attempt_id: input.attempt_id.map(str::to_owned),
        frozen_provider_input_id: input.frozen_provider_input_id.map(str::to_owned),
        sequence: next_sequence,
        event_type: input.kind.as_str().to_owned(),
        source: input.source.as_str().to_owned(),
        visibility: input.visibility.as_str().to_owned(),
        sensitivity: input.sensitivity.as_str().to_owned(),
        payload: input.payload,
        occurred_at_ms: input.occurred_at_ms,
        committed_at_ms,
    })
}

fn validate_context_retrieval_receipt_payload(payload: &Value) -> NativeResult<()> {
    let receipt: RunContextRetrievalReceipt =
        serde_json::from_value(payload.clone()).map_err(|error| {
            NativeError::invalid(
                "payload",
                format!("invalid retrieval receipt payload: {error}"),
            )
        })?;
    if receipt.query_sha256.len() != 64
        || !receipt
            .query_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(NativeError::invalid(
            "payload.querySha256",
            "must be a SHA-256 hex digest",
        ));
    }
    if let Some(hash) = receipt.index_snapshot_sha256.as_deref() {
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(NativeError::invalid(
                "payload.indexSnapshotSha256",
                "must be a SHA-256 hex digest",
            ));
        }
    }
    if receipt.index_snapshot_id.is_some() != receipt.index_snapshot_sha256.is_some() {
        return Err(NativeError::invalid(
            "payload",
            "snapshot identity and digest must be supplied together",
        ));
    }
    if let Some(snapshot_id) = receipt.index_snapshot_id.as_deref() {
        validate_bounded_text("payload.indexSnapshotId", snapshot_id, 256)?;
    }
    validate_bounded_text("payload.indexerVersion", &receipt.indexer_version, 128)?;
    validate_bounded_text("payload.scorerVersion", &receipt.scorer_version, 128)?;
    if receipt.token_budget == 0 || receipt.consumed_tokens > receipt.token_budget {
        return Err(NativeError::invalid(
            "payload",
            "retrieval token accounting exceeds its budget",
        ));
    }
    if receipt.matches.len() > 1024 || receipt.omissions.len() > 4096 {
        return Err(NativeError::invalid(
            "payload",
            "retrieval receipt exceeds bounded item limits",
        ));
    }
    if receipt.matched_candidates < receipt.matches.len() as u64 {
        return Err(NativeError::invalid(
            "payload.matchedCandidates",
            "cannot be smaller than the selected match count",
        ));
    }
    let mut chunk_ids = std::collections::HashSet::new();
    let mut consumed_tokens = 0_u64;
    for (ordinal, matched) in receipt.matches.iter().enumerate() {
        validate_bounded_text("payload.matches.chunkId", &matched.chunk_id, 256)?;
        validate_bounded_text("payload.matches.sourceId", &matched.source_id, 256)?;
        if !chunk_ids.insert(matched.chunk_id.as_str())
            || matched.rank as usize != ordinal + 1
            || !matched.score.is_finite()
            || matched.score < 0.0
            || matched.token_estimate == 0
            || matched.content_sha256.len() != 64
            || !matched
                .content_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(NativeError::invalid(
                "payload.matches",
                "contains an invalid bounded retrieval match",
            ));
        }
        if matched.reasons.is_empty() || matched.reasons.len() > 16 {
            return Err(NativeError::invalid(
                "payload.matches.reasons",
                "must contain between one and sixteen reasons",
            ));
        }
        for reason in &matched.reasons {
            validate_bounded_text("payload.matches.reasons", reason, 120)?;
        }
        consumed_tokens = consumed_tokens
            .checked_add(matched.token_estimate)
            .ok_or_else(|| {
                NativeError::invalid("payload.matches", "selected token accounting overflowed")
            })?;
    }
    if consumed_tokens != receipt.consumed_tokens {
        return Err(NativeError::invalid(
            "payload.consumedTokens",
            "must equal the selected match token total",
        ));
    }
    for omitted in &receipt.omissions {
        validate_bounded_text("payload.omissions.chunkId", &omitted.chunk_id, 256)?;
        validate_bounded_text("payload.omissions.reason", &omitted.reason, 120)?;
        if !chunk_ids.insert(omitted.chunk_id.as_str()) {
            return Err(NativeError::invalid(
                "payload.omissions",
                "contains a duplicate selected or omitted chunk",
            ));
        }
    }
    Ok(())
}

fn validate_event_transition(
    transaction: &Transaction<'_>,
    run_id: &str,
    next: RunEventKind,
) -> NativeResult<()> {
    let previous = transaction
        .query_row(
            "SELECT event_type
             FROM run_events
             WHERE run_id = ?1
               AND event_type <> 'context.retrieval_receipt'
             ORDER BY sequence_no DESC
             LIMIT 1",
            [run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let previous_kind = previous.as_deref().and_then(RunEventKind::from_str);
    if previous.is_some() && previous_kind.is_none() {
        return Err(NativeError::new(
            "run_journal_vocabulary_conflict",
            "The durable journal contains an unknown lifecycle event",
        ));
    }

    let allowed = match next {
        RunEventKind::RunCreated => previous_kind.is_none(),
        RunEventKind::AttemptCreated => previous_kind == Some(RunEventKind::RunCreated),
        RunEventKind::RunDispatching => previous_kind == Some(RunEventKind::AttemptCreated),
        RunEventKind::AttemptDispatchStarted => previous_kind == Some(RunEventKind::RunDispatching),
        RunEventKind::AttemptAccepted => {
            previous_kind == Some(RunEventKind::AttemptDispatchStarted)
        }
        RunEventKind::RunStarted => previous_kind == Some(RunEventKind::AttemptAccepted),
        RunEventKind::ContextRetrievalReceipt => matches!(
            previous_kind,
            Some(
                RunEventKind::RunCreated
                    | RunEventKind::AttemptCreated
                    | RunEventKind::RunDispatching
                    | RunEventKind::AttemptDispatchStarted
                    | RunEventKind::RunStarted
                    | RunEventKind::MessageTextDelta
                    | RunEventKind::MessageReasoningSummaryDelta
                    | RunEventKind::UsageUpdated
                    | RunEventKind::ContextRetrievalReceipt
            )
        ),
        RunEventKind::MessageTextDelta
        | RunEventKind::MessageReasoningSummaryDelta
        | RunEventKind::UsageUpdated => matches!(
            previous_kind,
            Some(
                RunEventKind::RunStarted
                    | RunEventKind::MessageTextDelta
                    | RunEventKind::MessageReasoningSummaryDelta
                    | RunEventKind::UsageUpdated
                    | RunEventKind::ContextRetrievalReceipt
            )
        ),
        RunEventKind::AttemptCompleted => matches!(
            previous_kind,
            Some(
                RunEventKind::RunStarted
                    | RunEventKind::MessageTextDelta
                    | RunEventKind::MessageReasoningSummaryDelta
                    | RunEventKind::UsageUpdated
                    | RunEventKind::ContextRetrievalReceipt
            )
        ),
        RunEventKind::AttemptInterrupted => matches!(
            previous_kind,
            Some(
                RunEventKind::AttemptDispatchStarted
                    | RunEventKind::RunStarted
                    | RunEventKind::MessageTextDelta
                    | RunEventKind::MessageReasoningSummaryDelta
                    | RunEventKind::UsageUpdated
                    | RunEventKind::ContextRetrievalReceipt
            )
        ),
        RunEventKind::AttemptFailed | RunEventKind::AttemptOutcomeUnknown => matches!(
            previous_kind,
            Some(
                RunEventKind::AttemptCreated
                    | RunEventKind::AttemptDispatchStarted
                    | RunEventKind::RunStarted
                    | RunEventKind::MessageTextDelta
                    | RunEventKind::MessageReasoningSummaryDelta
                    | RunEventKind::UsageUpdated
                    | RunEventKind::ContextRetrievalReceipt
                    | RunEventKind::RunRecovered
            )
        ),
        RunEventKind::RunCompleted => previous_kind == Some(RunEventKind::AttemptCompleted),
        RunEventKind::RunCancelled => previous_kind == Some(RunEventKind::AttemptInterrupted),
        RunEventKind::RunFailed => matches!(
            previous_kind,
            Some(RunEventKind::AttemptFailed | RunEventKind::AttemptOutcomeUnknown)
        ),
        RunEventKind::RunRecovered => matches!(
            previous_kind,
            Some(
                RunEventKind::AttemptCreated
                    | RunEventKind::AttemptDispatchStarted
                    | RunEventKind::RunStarted
                    | RunEventKind::MessageTextDelta
                    | RunEventKind::MessageReasoningSummaryDelta
                    | RunEventKind::UsageUpdated
                    | RunEventKind::ContextRetrievalReceipt
            )
        ),
    };
    if !allowed {
        return Err(NativeError::new(
            "run_journal_transition_conflict",
            "The durable run event is not valid after the current journal head",
        ));
    }
    Ok(())
}

pub fn provider_event<'a>(
    run_id: &'a str,
    attempt_id: &'a str,
    frozen_provider_input_id: &'a str,
    kind: RunEventKind,
    payload: Value,
    occurred_at_ms: i64,
) -> AppendRunEvent<'a> {
    AppendRunEvent {
        run_id,
        attempt_id: Some(attempt_id),
        frozen_provider_input_id: Some(frozen_provider_input_id),
        kind,
        source: RunEventSource::Provider,
        visibility: RunEventVisibility::User,
        sensitivity: RunEventSensitivity::Normal,
        payload,
        occurred_at_ms,
    }
}

/// Creates the redacted context admission event used before provider dispatch.
/// The caller still supplies the exact run journal transaction; this helper
/// never grants authority or executes retrieval itself.
pub fn retrieval_receipt_event<'a>(
    scope: &'a PreparedRunJournalScope,
    payload: Value,
    occurred_at_ms: i64,
) -> AppendRunEvent<'a> {
    AppendRunEvent {
        run_id: &scope.run_id,
        attempt_id: Some(&scope.attempt_id),
        frozen_provider_input_id: Some(&scope.frozen_provider_input_id),
        kind: RunEventKind::ContextRetrievalReceipt,
        source: RunEventSource::Harness,
        visibility: RunEventVisibility::Inspector,
        sensitivity: RunEventSensitivity::Normal,
        payload,
        occurred_at_ms,
    }
}

fn harness_prepared_event<'a>(
    scope: &'a PreparedRunJournalScope,
    kind: RunEventKind,
    payload: Value,
    occurred_at_ms: i64,
) -> AppendRunEvent<'a> {
    AppendRunEvent {
        run_id: &scope.run_id,
        attempt_id: Some(&scope.attempt_id),
        frozen_provider_input_id: Some(&scope.frozen_provider_input_id),
        kind,
        source: RunEventSource::Harness,
        visibility: RunEventVisibility::Inspector,
        sensitivity: RunEventSensitivity::Normal,
        payload,
        occurred_at_ms,
    }
}

fn failure_payload_with_class(error_code: &str, error_class: Option<ProviderErrorClass>) -> Value {
    let mut payload = json!({ "errorCode": error_code });
    if let Some(error_class) = error_class {
        payload["errorClass"] = serde_json::to_value(error_class)
            .expect("ProviderErrorClass serialization is infallible");
    }
    payload
}

fn failure_attempt_payload(
    error_code: &str,
    provider_acceptance: &str,
    phase: Option<&str>,
    error_class: Option<ProviderErrorClass>,
) -> Value {
    let mut payload = json!({
        "errorCode": error_code,
        "providerAcceptance": provider_acceptance,
    });
    if let Some(phase) = phase {
        payload["phase"] = Value::String(phase.to_owned());
    }
    if let Some(error_class) = error_class {
        payload["errorClass"] = serde_json::to_value(error_class)
            .expect("ProviderErrorClass serialization is infallible");
    }
    payload
}

fn event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunJournalEventRecord> {
    let payload_json: String = row.get(10)?;
    let payload = serde_json::from_str(&payload_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(RunJournalEventRecord {
        schema_version: row.get(0)?,
        id: row.get(1)?,
        run_id: row.get(2)?,
        journal_epoch: row.get(13)?,
        attempt_id: row.get(3)?,
        frozen_provider_input_id: row.get(4)?,
        sequence: row.get(5)?,
        event_type: row.get(6)?,
        source: row.get(7)?,
        visibility: row.get(8)?,
        sensitivity: row.get(9)?,
        payload,
        occurred_at_ms: row.get(11)?,
        committed_at_ms: row.get(12)?,
    })
}

fn cursor_at(
    connection: &rusqlite::Connection,
    run_id: &str,
    journal_epoch: &str,
    sequence: i64,
) -> NativeResult<RunJournalCursor> {
    let event_id = if sequence == 0 {
        None
    } else {
        Some(
            connection
                .query_row(
                    "SELECT id FROM run_events WHERE run_id = ?1 AND sequence_no = ?2",
                    params![run_id, sequence],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| {
                    NativeError::new(
                        "run_journal_cursor_conflict",
                        "The durable journal has a missing event at the requested sequence",
                    )
                })?,
        )
    };
    Ok(RunJournalCursor {
        schema_version: RUN_JOURNAL_CURSOR_SCHEMA_VERSION,
        run_id: run_id.to_owned(),
        journal_epoch: journal_epoch.to_owned(),
        sequence,
        event_id,
    })
}

fn validate_read_request(request: &ReadRunJournalRequest) -> NativeResult<ValidatedReplayWindow> {
    validate_prefixed_id("runId", &request.run_id, "run_")?;
    if let Some(journal_epoch) = request.journal_epoch.as_deref() {
        validate_prefixed_id("journalEpoch", journal_epoch, "journal_epoch_")?;
    }
    if let Some(event_id) = request.after_event_id.as_deref() {
        validate_prefixed_id("afterEventId", event_id, "run_event_")?;
    }
    if let Some(event_id) = request.through_event_id.as_deref() {
        validate_prefixed_id("throughEventId", event_id, "run_event_")?;
    }

    let after_sequence = request.after_sequence.unwrap_or(0);
    if after_sequence < 0 {
        return Err(NativeError::invalid(
            "afterSequence",
            "must be zero or a positive journal sequence",
        ));
    }
    if request.through_sequence.is_some_and(|value| value < 0) {
        return Err(NativeError::invalid(
            "throughSequence",
            "must be zero or a positive journal sequence",
        ));
    }
    validate_cursor_shape(
        "after",
        after_sequence,
        request.after_event_id.as_deref(),
        request.journal_epoch.as_deref(),
    )?;
    if let Some(through_sequence) = request.through_sequence {
        validate_cursor_shape(
            "through",
            through_sequence,
            request.through_event_id.as_deref(),
            request.journal_epoch.as_deref(),
        )?;
    } else if request.through_event_id.is_some() {
        return Err(NativeError::invalid(
            "throughEventId",
            "requires throughSequence",
        ));
    }

    let limit = request.limit.unwrap_or(250);
    if limit == 0 || limit > MAX_RUN_EVENT_REPLAY_PAGE_SIZE {
        return Err(NativeError::invalid("limit", "must be between 1 and 1000"));
    }
    Ok(ValidatedReplayWindow {
        after_sequence,
        through_sequence: request.through_sequence,
        limit,
    })
}

fn validate_cursor_shape(
    cursor_name: &'static str,
    sequence: i64,
    event_id: Option<&str>,
    journal_epoch: Option<&str>,
) -> NativeResult<()> {
    if sequence == 0 {
        if event_id.is_some() {
            return Err(NativeError::invalid(
                if cursor_name == "after" {
                    "afterEventId"
                } else {
                    "throughEventId"
                },
                "must be omitted when the sequence is zero",
            ));
        }
        return Ok(());
    }
    if journal_epoch.is_none() || event_id.is_none() {
        return Err(NativeError::new(
            "run_journal_cursor_incomplete",
            "A non-zero replay cursor must include its journal epoch and event identity",
        ));
    }
    Ok(())
}

fn validate_cursor_identity(
    connection: &rusqlite::Connection,
    run_id: &str,
    sequence: i64,
    expected_event_id: Option<&str>,
) -> NativeResult<()> {
    if sequence == 0 {
        return Ok(());
    }
    let actual_event_id = connection
        .query_row(
            "SELECT id FROM run_events WHERE run_id = ?1 AND sequence_no = ?2",
            params![run_id, sequence],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if actual_event_id.as_deref() != expected_event_id {
        return Err(cursor_conflict());
    }
    Ok(())
}

fn cursor_conflict() -> NativeError {
    NativeError::new(
        "run_journal_cursor_conflict",
        "The replay cursor does not identify this durable journal revision",
    )
}

fn merge_acceptance_evidence(
    current: &str,
    incoming: ProviderAcceptanceEvidence,
) -> NativeResult<&'static str> {
    match (current, incoming) {
        ("true", _) | (_, ProviderAcceptanceEvidence::Accepted) => Ok("true"),
        ("unknown", ProviderAcceptanceEvidence::NotAccepted)
        | ("unknown", ProviderAcceptanceEvidence::Unknown)
        | ("false", ProviderAcceptanceEvidence::Unknown) => Ok("unknown"),
        ("false", ProviderAcceptanceEvidence::NotAccepted) => Ok("false"),
        _ => Err(NativeError::new(
            "run_attempt_acceptance_invalid",
            "The provider attempt contains invalid acceptance evidence",
        )),
    }
}

fn assert_prepared_scope_state(
    transaction: &Transaction<'_>,
    scope: &PreparedRunJournalScope,
    allowed_attempt_states: &[&str],
) -> NativeResult<()> {
    assert_prepared_scope_state_with_run_states(
        transaction,
        scope,
        allowed_attempt_states,
        &["running"],
    )
}

fn assert_prepared_scope_state_with_run_states(
    transaction: &Transaction<'_>,
    scope: &PreparedRunJournalScope,
    allowed_attempt_states: &[&str],
    allowed_run_states: &[&str],
) -> NativeResult<()> {
    let run_placeholders = std::iter::repeat("?")
        .take(allowed_run_states.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT a.state
         FROM run_attempts a
         JOIN generations g ON g.id = a.generation_id
         JOIN frozen_provider_inputs f ON f.attempt_id = a.id
         WHERE a.id = ?1 AND a.generation_id = ?2
           AND f.id = ?3 AND f.run_id = ?2
           AND g.id = ?2 AND g.state IN ({run_placeholders})"
    );
    let mut bind_values: Vec<&dyn rusqlite::ToSql> = vec![
        &scope.attempt_id,
        &scope.run_id,
        &scope.frozen_provider_input_id,
    ];
    for state in allowed_run_states {
        bind_values.push(state);
    }
    let state = transaction
        .query_row(&sql, rusqlite::params_from_iter(bind_values), |row| {
            row.get::<_, String>(0)
        })
        .optional()?;
    let state = state.ok_or_else(|| {
        NativeError::new(
            "run_event_scope_conflict",
            "The exact run, attempt, and frozen input are not active together",
        )
    })?;
    if !allowed_attempt_states.contains(&state.as_str()) {
        return Err(NativeError::new(
            "run_state_conflict",
            "The exact provider attempt is not in the required state",
        ));
    }
    Ok(())
}

fn validate_bounded_text<'a>(
    field: &'static str,
    value: &'a str,
    maximum_bytes: usize,
) -> NativeResult<&'a str> {
    let value = value.trim();
    if value.is_empty() || value.len() > maximum_bytes || value.chars().any(char::is_control) {
        return Err(NativeError::invalid(
            field,
            "must be non-empty, bounded text without control characters",
        ));
    }
    Ok(value)
}

fn validate_prefixed_id(field: &'static str, value: &str, prefix: &str) -> NativeResult<()> {
    let suffix = value.strip_prefix(prefix).ok_or_else(|| {
        NativeError::invalid(field, "does not use the expected opaque identifier prefix")
    })?;
    if suffix.len() != 32 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(NativeError::invalid(
            field,
            "is not a valid opaque native identifier",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retrieval_receipt_payload_is_bounded_and_hash_scoped() {
        let payload = serde_json::json!({
            "querySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "indexSnapshotId": "workspace_index_1",
            "indexSnapshotSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "indexerVersion": "workspace-index-v1",
            "scorerVersion": "retriever-v1",
            "tokenBudget": 100,
            "consumedTokens": 10,
            "matchedCandidates": 1,
            "omissionReportTruncated": false,
            "matches": [{
                "chunkId": "chunk_1",
                "sourceId": "source_1",
                "rank": 1,
                "score": 0.9,
                "reasons": ["query_terms"],
                "tokenEstimate": 10,
                "contentSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
            }],
            "omissions": []
        });
        validate_context_retrieval_receipt_payload(&payload).expect("valid retrieval receipt");
    }

    #[test]
    fn retrieval_receipt_payload_rejects_budget_and_hash_drift() {
        let payload = serde_json::json!({
            "querySha256": "bad",
            "indexerVersion": "v1",
            "scorerVersion": "v1",
            "tokenBudget": 1,
            "consumedTokens": 2,
            "matchedCandidates": 0,
            "omissionReportTruncated": false,
            "matches": [],
            "omissions": []
        });
        assert!(validate_context_retrieval_receipt_payload(&payload).is_err());
    }

    #[test]
    fn cursor_contract_rejects_invalid_page_window() {
        let request = ReadRunJournalRequest {
            run_id: "run_0123456789abcdef0123456789abcdef".into(),
            journal_epoch: None,
            after_sequence: Some(-1),
            after_event_id: None,
            through_sequence: None,
            through_event_id: None,
            limit: Some(10),
        };
        assert_eq!(
            validate_read_request(&request).unwrap_err().code,
            "invalid_input"
        );
    }

    #[test]
    fn non_zero_cursor_requires_epoch_and_event_identity() {
        let request = ReadRunJournalRequest {
            run_id: "run_0123456789abcdef0123456789abcdef".into(),
            journal_epoch: None,
            after_sequence: Some(4),
            after_event_id: None,
            through_sequence: Some(9),
            through_event_id: None,
            limit: Some(10),
        };
        assert_eq!(
            validate_read_request(&request).unwrap_err().code,
            "run_journal_cursor_incomplete"
        );
    }

    #[test]
    fn stored_cursor_can_start_a_new_finite_replay_window() {
        let request = ReadRunJournalRequest {
            run_id: "run_0123456789abcdef0123456789abcdef".into(),
            journal_epoch: Some("journal_epoch_0123456789abcdef0123456789abcdef".into()),
            after_sequence: Some(4),
            after_event_id: Some("run_event_0123456789abcdef0123456789abcdef".into()),
            through_sequence: None,
            through_event_id: None,
            limit: Some(10),
        };
        let validated = validate_read_request(&request).unwrap();
        assert_eq!(validated.after_sequence, 4);
        assert_eq!(validated.through_sequence, None);
        assert_eq!(validated.limit, 10);
    }

    #[test]
    fn bounded_replay_cursor_contract_accepts_full_identity() {
        let request = ReadRunJournalRequest {
            run_id: "run_0123456789abcdef0123456789abcdef".into(),
            journal_epoch: Some("journal_epoch_0123456789abcdef0123456789abcdef".into()),
            after_sequence: Some(4),
            after_event_id: Some("run_event_0123456789abcdef0123456789abcdef".into()),
            through_sequence: Some(9),
            through_event_id: Some("run_event_fedcba9876543210fedcba9876543210".into()),
            limit: Some(1000),
        };
        let validated = validate_read_request(&request).unwrap();
        assert_eq!(validated.after_sequence, 4);
        assert_eq!(validated.through_sequence, Some(9));
        assert_eq!(validated.limit, 1000);
    }

    #[test]
    fn event_kind_vocabulary_matches_domain_contract() {
        assert_eq!(
            RunEventKind::MessageTextDelta.as_str(),
            "message.text_delta"
        );
        assert_eq!(RunEventKind::RunCompleted.as_str(), "run.completed");
        assert_eq!(
            RunEventKind::AttemptOutcomeUnknown.as_str(),
            "attempt.outcome_unknown"
        );
    }

    #[test]
    fn provider_acceptance_evidence_is_monotonic() {
        assert_eq!(
            merge_acceptance_evidence("true", ProviderAcceptanceEvidence::Unknown).unwrap(),
            "true"
        );
        assert_eq!(
            merge_acceptance_evidence("unknown", ProviderAcceptanceEvidence::NotAccepted).unwrap(),
            "unknown"
        );
        assert_eq!(
            merge_acceptance_evidence("false", ProviderAcceptanceEvidence::Unknown).unwrap(),
            "unknown"
        );
    }

    #[test]
    fn provider_failure_evidence_rejects_contradictory_claims() {
        let definitive_unknown = ProviderAttemptFailureEvidence::Definitive {
            acceptance: ProviderAcceptanceEvidence::Unknown,
        };
        assert_eq!(
            definitive_unknown.validate().unwrap_err().code,
            "provider_evidence_conflict"
        );

        let unknown_not_accepted = ProviderAttemptFailureEvidence::OutcomeUnknown {
            acceptance: ProviderAcceptanceEvidence::NotAccepted,
        };
        assert_eq!(
            unknown_not_accepted.validate().unwrap_err().code,
            "provider_evidence_conflict"
        );
    }

    #[test]
    fn failure_payload_preserves_legacy_shape_without_a_class() {
        assert_eq!(
            failure_payload_with_class("provider_request_rejected", None),
            json!({ "errorCode": "provider_request_rejected" })
        );
        assert_eq!(
            failure_attempt_payload(
                "provider_request_rejected",
                "false",
                Some("pre_dispatch"),
                None,
            ),
            json!({
                "errorCode": "provider_request_rejected",
                "providerAcceptance": "false",
                "phase": "pre_dispatch",
            })
        );
    }

    #[test]
    fn failure_payload_persists_the_allowlisted_class_alongside_acceptance() {
        assert_eq!(
            failure_payload_with_class(
                "provider_request_rejected",
                Some(ProviderErrorClass::Authentication),
            ),
            json!({
                "errorCode": "provider_request_rejected",
                "errorClass": "authentication",
            })
        );
        assert_eq!(
            failure_attempt_payload(
                "provider_temporarily_unavailable",
                "unknown",
                None,
                Some(ProviderErrorClass::RateLimit),
            ),
            json!({
                "errorCode": "provider_temporarily_unavailable",
                "providerAcceptance": "unknown",
                "errorClass": "rate-limit",
            })
        );
    }
}
