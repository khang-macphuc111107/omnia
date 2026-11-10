//! Native-owned, content-free receipts for multi-model comparison.
//!
//! A compare operation is deliberately a projection over already prepared
//! provider attempts.  This module never starts a provider request and never
//! accepts model output text.  It validates the exact run/attempt/frozen-input
//! lineage inside one SQLite snapshot, derives per-attempt usage and output
//! hashes from native storage, and returns an immutable merge receipt.

use std::collections::BTreeSet;

use crate::{
    error::{NativeError, NativeResult},
    provider_attempt_lineage::ReadProviderAttemptLineageRequest,
    storage::{
        load_historical_provider_input_from_connection, load_provider_attempt_lineage_fact, now_ms,
        sha256_hex, Storage,
    },
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub const MODEL_COMPARE_RECEIPT_SCHEMA: u32 = 1;
pub const MODEL_COMPARE_MAX_ATTEMPTS: usize = 4;
const MAX_RATIONALE_BYTES: usize = 8 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateModelCompareReceiptRequest {
    pub compare_id: String,
    pub conversation_id: String,
    pub branch_id: String,
    /// Optional expectation for SHA-256 of the canonical logical messages,
    /// without provider, model, parameters or execution identifiers.
    pub logical_input_sha256: Option<String>,
    pub attempts: Vec<ModelCompareAttemptRef>,
    pub selected_attempt_ids: Vec<String>,
    pub strategy: ModelCompareMergeStrategy,
    pub rationale: String,
    /// Native completed attempt which produced the final answer. For best-of
    /// this must be the selected candidate; a synthesized merge may point to a
    /// separate completed native attempt in the same conversation/branch.
    pub final_output: ModelCompareAttemptRef,
    pub final_output_sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelCompareAttemptRef {
    pub run_id: String,
    pub attempt_id: String,
    pub frozen_provider_input_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ModelCompareMergeStrategy {
    BestOf,
    Consensus,
    Manual,
    Weighted,
}

impl ModelCompareMergeStrategy {
    fn as_str(self) -> &'static str {
        match self {
            Self::BestOf => "best-of",
            Self::Consensus => "consensus",
            Self::Manual => "manual",
            Self::Weighted => "weighted",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCompareAttemptReceipt {
    pub run_id: String,
    pub attempt_id: String,
    pub frozen_provider_input_id: String,
    pub provider_profile_id: String,
    pub model_id: String,
    pub status: String,
    pub output_sha256: Option<String>,
    pub lineage_sha256: String,
    pub resolved_parameters_sha256: String,
    /// Preserve the source/authority/coverage of each normalized observation.
    /// Taking a max or sum across mixed sources would invent billing totals.
    pub usage_observations: Vec<ModelCompareUsageObservation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCompareUsageObservation {
    pub sequence: i64,
    pub source: String,
    pub authoritative: bool,
    pub coverage: String,
    pub observed_at_ms: i64,
    pub input_tokens: Option<u64>,
    pub cache_read_input_tokens: Option<u64>,
    pub cache_write_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub visible_output_tokens: Option<u64>,
    pub cost_statement_count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCompareMergeReceipt {
    pub schema_version: u32,
    pub compare_id: String,
    pub conversation_id: String,
    pub branch_id: String,
    pub logical_input_sha256: String,
    pub attempts: Vec<ModelCompareAttemptReceipt>,
    pub selected_attempt_ids: Vec<String>,
    pub strategy: String,
    pub rationale_sha256: String,
    pub final_output_run_id: String,
    pub final_output_attempt_id: String,
    pub final_output_lineage_sha256: String,
    pub final_output_sha256: String,
    pub created_at_ms: i64,
    pub receipt_sha256: String,
}

pub fn validate_request_shape(request: &CreateModelCompareReceiptRequest) -> NativeResult<()> {
    validate_id("compareId", &request.compare_id, "compare_")?;
    validate_id("conversationId", &request.conversation_id, "conversation_")?;
    validate_id("branchId", &request.branch_id, "branch_")?;
    if let Some(digest) = request.logical_input_sha256.as_deref() {
        validate_sha256("logicalInputSha256", digest)?;
    }
    if let Some(digest) = request.final_output_sha256.as_deref() {
        validate_sha256("finalOutputSha256", digest)?;
    }
    if request.attempts.len() < 2 || request.attempts.len() > MODEL_COMPARE_MAX_ATTEMPTS {
        return Err(NativeError::invalid(
            "attempts",
            "must contain between two and four provider attempts",
        ));
    }
    let mut attempts = BTreeSet::new();
    let mut runs = BTreeSet::new();
    for attempt in &request.attempts {
        validate_id("runId", &attempt.run_id, "run_")?;
        validate_id("attemptId", &attempt.attempt_id, "attempt_")?;
        validate_id(
            "frozenProviderInputId",
            &attempt.frozen_provider_input_id,
            "provider_input_",
        )?;
        if !attempts.insert(attempt.attempt_id.clone()) || !runs.insert(attempt.run_id.clone()) {
            return Err(NativeError::invalid(
                "attempts",
                "attempt and run ids must be unique",
            ));
        }
    }
    validate_attempt_ref(&request.final_output)?;
    if !request.attempts.iter().any(|attempt| {
        attempt.run_id == request.final_output.run_id
            && attempt.attempt_id == request.final_output.attempt_id
            && attempt.frozen_provider_input_id == request.final_output.frozen_provider_input_id
    }) {
        return Err(NativeError::invalid(
            "finalOutput",
            "must refer to one of the compare attempts",
        ));
    }
    if request.selected_attempt_ids.is_empty() {
        return Err(NativeError::invalid(
            "selectedAttemptIds",
            "must select at least one completed attempt",
        ));
    }
    let selected = request.selected_attempt_ids.iter().collect::<BTreeSet<_>>();
    if selected.len() != request.selected_attempt_ids.len()
        || selected.iter().any(|id| !attempts.contains(id.as_str()))
    {
        return Err(NativeError::invalid(
            "selectedAttemptIds",
            "must be unique and belong to the compare attempt set",
        ));
    }
    if request.rationale.trim().is_empty() || request.rationale.len() > MAX_RATIONALE_BYTES {
        return Err(NativeError::invalid(
            "rationale",
            "must be non-empty and bounded",
        ));
    }
    if matches!(
        request.strategy,
        ModelCompareMergeStrategy::Consensus | ModelCompareMergeStrategy::Weighted
    ) {
        return Err(NativeError::new(
            "model_compare_synthesis_unavailable",
            "Consensus and weighted synthesis require a native merge execution receipt before they can be attested",
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn model_compare_receipt_create(
    state: tauri::State<'_, crate::state::AppState>,
    request: CreateModelCompareReceiptRequest,
) -> NativeResult<ModelCompareMergeReceipt> {
    state.storage.create_model_compare_receipt(request)
}

impl Storage {
    /// Validates and derives a comparison receipt from terminal native runs.
    /// No provider dispatch occurs here; all facts come from one SQLite
    /// snapshot and all returned data is content-free apart from hashes.
    pub fn create_model_compare_receipt(
        &self,
        request: CreateModelCompareReceiptRequest,
    ) -> NativeResult<ModelCompareMergeReceipt> {
        validate_request_shape(&request)?;
        let now = now_ms();
        self.with_transaction(|transaction| build_receipt(transaction, &request, now))
    }
}

fn build_receipt(
    transaction: &Transaction<'_>,
    request: &CreateModelCompareReceiptRequest,
    created_at_ms: i64,
) -> NativeResult<ModelCompareMergeReceipt> {
    let mut receipts = Vec::with_capacity(request.attempts.len());
    let mut logical_digest: Option<String> = None;
    for attempt in &request.attempts {
        let input = load_historical_provider_input_from_connection(
            transaction,
            &ReadProviderAttemptLineageRequest {
                conversation_id: request.conversation_id.clone(),
                branch_id: request.branch_id.clone(),
                run_id: attempt.run_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
            },
        )?;
        input.validate()?;
        if input.id != attempt.frozen_provider_input_id {
            return Err(NativeError::new(
                "model_compare_attempt_scope_denied",
                "The frozen input does not belong to the selected compare attempt",
            ));
        }
        let fact = load_provider_attempt_lineage_fact(transaction, &input.id)?;
        fact.assert_frozen_input(&input)?;
        let messages_json = serde_json::to_string(&input.messages).map_err(|_| {
            NativeError::new(
                "prepared_input_integrity_failed",
                "Could not serialize frozen messages",
            )
        })?;
        let digest = logical_input_digest(&messages_json)?;
        let row = transaction
            .query_row(
                "SELECT a.provider_profile_id, a.model_id, a.state,
                        f.id,
                        m.content_sha256, m.content_text, m.status
                 FROM run_attempts a
                 JOIN generations g ON g.id = a.generation_id
                    AND g.conversation_id = ?1 AND g.branch_id = ?2
                    AND g.state IN ('complete', 'failed', 'cancelled')
                 JOIN frozen_provider_inputs f ON f.run_id = a.generation_id
                    AND f.attempt_id = a.id AND f.id = ?5
                 LEFT JOIN messages m ON m.id = g.assistant_message_id
                 WHERE a.generation_id = ?3 AND a.id = ?4",
                params![
                    request.conversation_id,
                    request.branch_id,
                    attempt.run_id,
                    attempt.attempt_id,
                    attempt.frozen_provider_input_id
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| {
                NativeError::new(
                    "model_compare_attempt_scope_denied",
                    "A compare attempt is not a terminal, owned run with matching frozen input lineage",
                )
            })?;

        let (
            provider_profile_id,
            model_id,
            state,
            frozen_id,
            output_sha256,
            output_text,
            message_status,
        ) = row;
        if let Some(expected) = logical_digest.as_ref() {
            if expected != &digest {
                return Err(NativeError::new(
                    "model_compare_input_conflict",
                    "Compare attempts do not share one canonical logical input",
                ));
            }
        } else {
            logical_digest = Some(digest.clone());
        }
        let status = match state.as_str() {
            "complete" => "completed",
            "failed" => "failed",
            "interrupted" | "cancelled" => "cancelled",
            "outcome_unknown" => "unknown",
            _ => {
                return Err(NativeError::new(
                    "model_compare_attempt_not_terminal",
                    "Every compare attempt must be terminal",
                ))
            }
        };
        if request
            .selected_attempt_ids
            .iter()
            .any(|id| id == &attempt.attempt_id)
            && status != "completed"
        {
            return Err(NativeError::new(
                "model_compare_selection_invalid",
                "Only completed attempts may be selected for the merge",
            ));
        }
        if status == "completed"
            && (message_status.as_deref() != Some("complete")
                || output_text
                    .as_deref()
                    .map(|text| sha256_hex(text.as_bytes()))
                    .as_ref()
                    != output_sha256.as_ref())
        {
            return Err(NativeError::new(
                "model_compare_output_missing",
                "A completed compare attempt is missing its finalized output hash",
            ));
        }
        receipts.push(ModelCompareAttemptReceipt {
            run_id: attempt.run_id.clone(),
            attempt_id: attempt.attempt_id.clone(),
            frozen_provider_input_id: frozen_id,
            provider_profile_id,
            model_id,
            status: status.to_owned(),
            output_sha256,
            lineage_sha256: fact.lineage_sha256,
            resolved_parameters_sha256: fact.resolved_parameters_sha256,
            usage_observations: load_usage_observations(
                transaction,
                &attempt.run_id,
                &attempt.attempt_id,
            )?,
        });
    }
    let final_output_input = load_historical_provider_input_from_connection(
        transaction,
        &ReadProviderAttemptLineageRequest {
            conversation_id: request.conversation_id.clone(),
            branch_id: request.branch_id.clone(),
            run_id: request.final_output.run_id.clone(),
            attempt_id: request.final_output.attempt_id.clone(),
        },
    )?;
    final_output_input.validate()?;
    if final_output_input.id != request.final_output.frozen_provider_input_id {
        return Err(NativeError::new(
            "model_compare_output_scope_denied",
            "The final output frozen input does not match its attempt",
        ));
    }
    let final_output_fact =
        load_provider_attempt_lineage_fact(transaction, &final_output_input.id)?;
    final_output_fact.assert_frozen_input(&final_output_input)?;
    let final_output_sha256 = load_completed_output_hash(transaction, &request.final_output)?;
    if request.selected_attempt_ids.len() != 1
        || request.selected_attempt_ids[0] != request.final_output.attempt_id
    {
        return Err(NativeError::new(
            "model_compare_selection_invalid",
            "Selection receipts must return exactly the selected completed candidate output",
        ));
    }
    if request
        .final_output_sha256
        .as_ref()
        .is_some_and(|expected| expected.to_ascii_lowercase() != final_output_sha256)
    {
        return Err(NativeError::new(
            "model_compare_output_hash_conflict",
            "The supplied final output hash does not match native finalized content",
        ));
    }
    if request
        .logical_input_sha256
        .as_ref()
        .is_some_and(|expected| {
            logical_digest.as_deref() != Some(expected.to_ascii_lowercase().as_str())
        })
    {
        return Err(NativeError::new(
            "model_compare_input_hash_conflict",
            "The supplied logical input hash does not match native frozen inputs",
        ));
    }
    let mut receipt = ModelCompareMergeReceipt {
        schema_version: MODEL_COMPARE_RECEIPT_SCHEMA,
        compare_id: request.compare_id.clone(),
        conversation_id: request.conversation_id.clone(),
        branch_id: request.branch_id.clone(),
        logical_input_sha256: logical_digest.expect("bounded compare attempts are non-empty"),
        attempts: receipts,
        selected_attempt_ids: request.selected_attempt_ids.clone(),
        strategy: request.strategy.as_str().to_owned(),
        rationale_sha256: sha256_hex(request.rationale.trim().as_bytes()),
        final_output_run_id: request.final_output.run_id.clone(),
        final_output_attempt_id: request.final_output.attempt_id.clone(),
        final_output_lineage_sha256: final_output_fact.lineage_sha256,
        final_output_sha256,
        created_at_ms,
        receipt_sha256: String::new(),
    };
    let material = serde_json::to_vec(&receipt).map_err(|_| {
        NativeError::new(
            "model_compare_receipt_failed",
            "Could not serialize compare receipt",
        )
    })?;
    receipt.receipt_sha256 = sha256_hex(&material);
    Ok(receipt)
}

fn logical_input_digest(messages_json: &str) -> NativeResult<String> {
    let messages: serde_json::Value = serde_json::from_str(messages_json).map_err(|_| {
        NativeError::new(
            "prepared_input_integrity_failed",
            "Frozen messages are malformed",
        )
    })?;
    let material = serde_json::to_vec(&json!({ "messages": messages })).map_err(|_| {
        NativeError::new(
            "model_compare_receipt_failed",
            "Could not hash logical input",
        )
    })?;
    Ok(sha256_hex(&material))
}

fn validate_id(field: &'static str, value: &str, prefix: &str) -> NativeResult<()> {
    let suffix = value
        .strip_prefix(prefix)
        .ok_or_else(|| NativeError::invalid(field, "has an invalid identifier prefix"))?;
    if suffix.len() != 32 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(NativeError::invalid(field, "is malformed"));
    }
    Ok(())
}

fn validate_sha256(field: &'static str, value: &str) -> NativeResult<()> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(NativeError::invalid(field, "must be a SHA-256 hex digest"));
    }
    Ok(())
}

fn validate_attempt_ref(attempt: &ModelCompareAttemptRef) -> NativeResult<()> {
    validate_id("runId", &attempt.run_id, "run_")?;
    validate_id("attemptId", &attempt.attempt_id, "attempt_")?;
    validate_id(
        "frozenProviderInputId",
        &attempt.frozen_provider_input_id,
        "provider_input_",
    )
}

fn load_usage_observations(
    transaction: &Transaction<'_>,
    run_id: &str,
    attempt_id: &str,
) -> NativeResult<Vec<ModelCompareUsageObservation>> {
    let rows = transaction
        .prepare(
            "SELECT ledger.sequence_no, ledger.source, ledger.authoritative,
                    ledger.coverage, ledger.observed_at_ms, ledger.input_tokens,
                    ledger.cache_read_input_tokens, ledger.cache_write_input_tokens,
                    ledger.output_tokens, ledger.reasoning_tokens,
                    ledger.visible_output_tokens,
                    (SELECT COUNT(*) FROM run_cost_statements cost
                     WHERE cost.usage_entry_id = ledger.id)
             FROM run_usage_ledger ledger
             WHERE ledger.profile_id = 'profile_default'
               AND ledger.run_id = ?1 AND ledger.attempt_id = ?2
             ORDER BY ledger.sequence_no ASC, ledger.id ASC LIMIT 128",
        )?
        .query_map(params![run_id, attempt_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, Option<i64>>(8)?,
                row.get::<_, Option<i64>>(9)?,
                row.get::<_, Option<i64>>(10)?,
                row.get::<_, i64>(11)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|row| {
            Ok(ModelCompareUsageObservation {
                sequence: row.0,
                source: row.1,
                authoritative: row.2,
                coverage: row.3,
                observed_at_ms: row.4,
                input_tokens: u64_option(row.5)?,
                cache_read_input_tokens: u64_option(row.6)?,
                cache_write_input_tokens: u64_option(row.7)?,
                output_tokens: u64_option(row.8)?,
                reasoning_tokens: u64_option(row.9)?,
                visible_output_tokens: u64_option(row.10)?,
                cost_statement_count: u32::try_from(row.11).map_err(|_| {
                    NativeError::new(
                        "model_compare_usage_invalid",
                        "Cost statement count exceeds bounds",
                    )
                })?,
            })
        })
        .collect()
}

fn u64_option(value: Option<i64>) -> NativeResult<Option<u64>> {
    value
        .map(|value| {
            u64::try_from(value).map_err(|_| {
                NativeError::new(
                    "model_compare_usage_invalid",
                    "Usage counters cannot be negative",
                )
            })
        })
        .transpose()
}

fn load_completed_output_hash(
    transaction: &Transaction<'_>,
    attempt: &ModelCompareAttemptRef,
) -> NativeResult<String> {
    let output = transaction
        .query_row(
            "SELECT m.content_text, m.content_sha256
         FROM generations g
         JOIN run_attempts a ON a.generation_id = g.id AND a.id = ?2 AND a.state = 'complete'
         JOIN messages m ON m.id = g.assistant_message_id AND m.status = 'complete'
         WHERE g.id = ?1 AND g.state = 'complete'",
            params![attempt.run_id, attempt.attempt_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| {
            NativeError::new(
                "model_compare_output_missing",
                "The final output must be a completed native attempt",
            )
        })?;
    if sha256_hex(output.0.as_bytes()) != output.1 {
        return Err(NativeError::new(
            "model_compare_output_integrity_failed",
            "The finalized native output hash does not match its content",
        ));
    }
    Ok(output.1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(prefix: &str) -> String {
        format!("{prefix}{}", "a".repeat(32))
    }

    fn request() -> CreateModelCompareReceiptRequest {
        CreateModelCompareReceiptRequest {
            compare_id: id("compare_"),
            conversation_id: id("conversation_"),
            branch_id: id("branch_"),
            logical_input_sha256: Some("a".repeat(64)),
            attempts: vec![
                ModelCompareAttemptRef {
                    run_id: id("run_"),
                    attempt_id: id("attempt_"),
                    frozen_provider_input_id: id("provider_input_"),
                },
                ModelCompareAttemptRef {
                    run_id: format!("run_{}", "b".repeat(32)),
                    attempt_id: format!("attempt_{}", "b".repeat(32)),
                    frozen_provider_input_id: format!("provider_input_{}", "b".repeat(32)),
                },
            ],
            selected_attempt_ids: vec![id("attempt_")],
            strategy: ModelCompareMergeStrategy::BestOf,
            rationale: "selected by deterministic evaluator".to_owned(),
            final_output: ModelCompareAttemptRef {
                run_id: id("run_"),
                attempt_id: id("attempt_"),
                frozen_provider_input_id: id("provider_input_"),
            },
            final_output_sha256: Some("b".repeat(64)),
        }
    }

    #[test]
    fn validates_bounded_compare_shape() {
        validate_request_shape(&request()).expect("valid shape");
    }

    #[test]
    fn rejects_duplicate_attempts_and_unknown_selection() {
        let mut duplicate = request();
        duplicate.attempts[1].attempt_id = duplicate.attempts[0].attempt_id.clone();
        assert!(validate_request_shape(&duplicate).is_err());
        let mut unknown = request();
        unknown.selected_attempt_ids = vec![id("attempt_").replace('a', "c")];
        assert!(validate_request_shape(&unknown).is_err());
    }
}
