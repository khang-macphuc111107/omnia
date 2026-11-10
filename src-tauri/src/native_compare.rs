//! Native provider fan out for multi model comparison.
//!
//! A compare run is deliberately kept separate from the SQLite receipt
//! command in [`model_compare_receipt`].  This module executes already
//! prepared provider requests through the real `omnia-harness::Provider`
//! abstraction and returns two projections:
//!
//! * [`CompareExecution`] keeps the provider text in memory for the caller
//!   that owns the independent attempt sessions.
//! * [`CompareMergeReceipt`] is an immutable, content free proof containing
//!   route, provenance, usage, terminal status, and hashes only.
//!
//! The native storage layer can use the attempt identities and the shared
//! logical input digest from this module when it persists the individual
//! attempts.  It does not need to trust renderer supplied output or usage.

use std::{
    collections::BTreeSet,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use omnia_harness::{
    Block, CancellationToken, HarnessError, Message, MessageAccumulator, Provider, ProviderRequest,
    Role, StopReason, StreamEvent, Usage,
};

use crate::error::{NativeError, NativeResult};
use crate::{
    prepared_provider_input::{FrozenProviderInput, StartPreparedAttemptRequest},
    provider_gateway,
    run_journal::{
        PreparedRunJournalScope, ProviderAcceptanceEvidence, ProviderAttemptFailureEvidence,
        ProviderUsageSnapshot,
    },
    storage::Storage,
};

pub const NATIVE_COMPARE_SCHEMA_VERSION: u32 = 1;
pub const MAX_COMPARE_ATTEMPTS: usize = 4;
pub const MIN_COMPARE_ATTEMPTS: usize = 2;
const MAX_COMPARE_ID_BYTES: usize = 256;
const MAX_ROUTE_ID_BYTES: usize = 256;
const MAX_MODEL_ID_BYTES: usize = 512;
const MAX_PROVIDER_ID_BYTES: usize = 256;
const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
#[cfg(test)]
const MAX_RATIONALE_BYTES: usize = 8 * 1024;

/// The native status of one independent provider attempt.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompareAttemptStatus {
    Completed,
    Failed,
    Cancelled,
    /// The provider accepted or started the stream, but the terminal outcome
    /// could not be established.  This is intentionally distinct from a
    /// definitive provider failure so a caller cannot retry unknowingly.
    Unknown,
}

/// A route selected for one compare candidate.
///
/// `provider` is the native adapter instance.  It is never serialized and is
/// never included in a receipt.  The explicit route metadata is used for
/// durable attribution while the adapter id is read again from the provider
/// immediately before dispatch.
#[derive(Clone)]
pub struct CompareRoute {
    pub route_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub provider: Arc<dyn Provider>,
}

impl std::fmt::Debug for CompareRoute {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CompareRoute")
            .field("route_id", &self.route_id)
            .field("provider_id", &self.provider_id)
            .field("model_id", &self.model_id)
            .field("adapter_id", &self.provider.id())
            .finish()
    }
}

/// Frozen logical request shared by every route.
///
/// The model field is deliberately excluded from the digest because each
/// candidate route supplies its own model.  All other request fields are
/// cloned for each provider attempt and cannot be changed by one attempt.
#[derive(Clone, Debug)]
pub struct FrozenCompareInput {
    request: ProviderRequest,
    logical_input_sha256: String,
}

impl FrozenCompareInput {
    pub fn freeze(request: ProviderRequest) -> NativeResult<Self> {
        let serialized = logical_request_bytes(&request)?;
        if serialized.len() > MAX_INPUT_BYTES {
            return Err(NativeError::invalid(
                "compareInput",
                "exceeds the native compare input limit",
            ));
        }
        let digest = sha256_hex(&serialized);
        Ok(Self {
            request,
            logical_input_sha256: digest,
        })
    }

    /// Rebuilds a frozen input and checks a digest recorded by the context
    /// compiler.  A mismatch is a hard scope error rather than a best effort
    /// warning, since all compare attempts must share one logical input.
    #[cfg(test)]
    pub fn freeze_with_digest(
        request: ProviderRequest,
        expected_sha256: &str,
    ) -> NativeResult<Self> {
        validate_sha256("logicalInputSha256", expected_sha256)?;
        let frozen = Self::freeze(request)?;
        if frozen.logical_input_sha256 != expected_sha256.to_ascii_lowercase() {
            return Err(NativeError::new(
                "compare_input_digest_conflict",
                "The supplied compare input digest does not match the frozen request",
            ));
        }
        Ok(frozen)
    }

    pub fn logical_input_sha256(&self) -> &str {
        &self.logical_input_sha256
    }

    pub fn request(&self) -> &ProviderRequest {
        &self.request
    }
}

/// Opaque native references used to execute a compare fan-out.
///
/// The renderer is intentionally unable to provide messages, parameters,
/// provider URLs, credentials, or model names here. Those values are loaded
/// from the immutable prepared input and dispatch proof in native storage.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeComparePreparedRoute {
    pub route_id: String,
    pub attempt_id: String,
    pub frozen_provider_input_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCompareExecutePreparedRequest {
    pub compare_id: String,
    pub routes: Vec<NativeComparePreparedRoute>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCompareUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

impl From<Usage> for NativeCompareUsage {
    fn from(value: Usage) -> Self {
        Self {
            input_tokens: value.input_tokens,
            output_tokens: value.output_tokens,
            cache_read_tokens: value.cache_read_tokens,
            cache_write_tokens: value.cache_write_tokens,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCompareAttemptResult {
    /// Runtime compare-attempt identity generated by the native fan-out.
    pub attempt_id: String,
    pub route_id: String,
    /// The prepared native attempt that supplied the frozen input.
    pub prepared_attempt_id: String,
    pub provider_id: String,
    pub adapter_id: String,
    pub model_id: String,
    pub status: CompareAttemptStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_sha256: Option<String>,
    pub usage: NativeCompareUsage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<StopReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCompareExecutePreparedResult {
    pub schema_version: u32,
    pub compare_id: String,
    pub logical_input_sha256: String,
    pub attempts: Vec<NativeCompareAttemptResult>,
    pub completed_at_ms: i64,
}

/// Executes already-prepared provider inputs through native provider
/// adapters. The request contains only opaque attempt/input identifiers;
/// all provider material and prompt content is resolved from native storage.
///
/// This command deliberately returns a bounded in-memory projection. Durable
/// run journal completion and merge attestation remain separate operations and
/// must use the normal prepared-attempt lifecycle.
#[tauri::command]
pub async fn native_compare_execute_prepared(
    state: tauri::State<'_, crate::state::AppState>,
    request: NativeCompareExecutePreparedRequest,
) -> NativeResult<NativeCompareExecutePreparedResult> {
    validate_bounded_text("compareId", &request.compare_id, MAX_COMPARE_ID_BYTES)?;
    if request.routes.len() < MIN_COMPARE_ATTEMPTS || request.routes.len() > MAX_COMPARE_ATTEMPTS {
        return Err(NativeError::invalid(
            "routes",
            "must contain between two and four provider routes",
        ));
    }

    let mut route_ids = BTreeSet::new();
    let mut attempt_ids = BTreeSet::new();
    let mut frozen_input_ids = BTreeSet::new();
    // Resolve and validate every opaque prepared input before mutating any
    // attempt state.  This keeps the claim boundary all-or-nothing when a
    // later route has a stale input, malformed parameter projection, or a
    // conflicting logical digest.
    let mut prepared = Vec::with_capacity(request.routes.len());
    for route in request.routes {
        validate_bounded_text("routeId", &route.route_id, MAX_ROUTE_ID_BYTES)?;
        if !route_ids.insert(route.route_id.clone()) {
            return Err(NativeError::invalid(
                "routes",
                "route identities must be unique",
            ));
        }
        if !attempt_ids.insert(route.attempt_id.clone()) {
            return Err(NativeError::invalid(
                "routes",
                "prepared attempt identities must be unique",
            ));
        }
        if !frozen_input_ids.insert(route.frozen_provider_input_id.clone()) {
            return Err(NativeError::invalid(
                "routes",
                "frozen provider input identities must be unique",
            ));
        }
        let dispatch = StartPreparedAttemptRequest {
            attempt_id: route.attempt_id.clone(),
            frozen_provider_input_id: route.frozen_provider_input_id.clone(),
        };
        // This is the security boundary: the exact input, active profile,
        // immutable provider definition, and attempt lineage are all checked
        // inside one native storage transaction before a provider is built.
        let (input, proof) = state
            .storage
            .load_prepared_provider_dispatch_proof(&dispatch)?;
        let provider_request = provider_request_from_frozen(&input)?;
        prepared.push((route, input, proof, provider_request));
    }

    let first_request = prepared
        .first()
        .map(|entry| entry.3.clone())
        .ok_or_else(|| NativeError::invalid("routes", "must not be empty"));
    let frozen = first_request.and_then(FrozenCompareInput::freeze)?;
    for (_, _, _, provider_request) in prepared.iter().skip(1) {
        let candidate = FrozenCompareInput::freeze(provider_request.clone())?;
        if candidate.logical_input_sha256() != frozen.logical_input_sha256() {
            return Err(NativeError::new(
                "compare_input_conflict",
                "Prepared compare routes do not share one logical provider input",
            ));
        }
    }

    // Claim every prepared attempt before opening a provider stream.  The
    // compare command used to load a proof and then call the harness directly,
    // leaving all rows in `queued`/`created` with a NULL dispatch marker.  A
    // replay could therefore start the same attempt through the normal
    // gateway while this fan-out was still running.  The native transition is
    // linearized per attempt and writes the dispatch journal in the same
    // transaction as the state change.
    let mut claimed = Vec::with_capacity(prepared.len());
    for (_, input, _, _) in &prepared {
        let dispatch = StartPreparedAttemptRequest {
            attempt_id: input.attempt_id.clone(),
            frozen_provider_input_id: input.id.clone(),
        };
        if let Err(error) = state.storage.mark_prepared_attempt_dispatching(&dispatch) {
            // A later route can fail its compare-and-swap after earlier routes
            // were claimed.  Do not leave those attempts dispatching forever;
            // the provider was never opened for them, so this is a definitive
            // pre-dispatch failure and remains safely retryable by policy.
            for (run_id, attempt_id, input_id) in claimed.drain(..) {
                if let Ok(scope) = PreparedRunJournalScope::new(run_id, attempt_id, input_id) {
                    let _ = state.storage.journal_run_failed_with_class(
                        &scope,
                        "compare_dispatch_aborted",
                        None,
                        ProviderAttemptFailureEvidence::Definitive {
                            acceptance: ProviderAcceptanceEvidence::NotAccepted,
                        },
                        now_ms(),
                    );
                }
            }
            return Err(error);
        }
        claimed.push((
            input.run_id.clone(),
            input.attempt_id.clone(),
            input.id.clone(),
        ));
    }

    // Provider construction performs endpoint/DNS/credential checks.  Keep it
    // after the durable claim so a provider setup failure cannot leave an
    // attempt looking queued while a native adapter was already consulted.
    let mut dispatch_ready = Vec::with_capacity(prepared.len());
    for (route, input, proof, provider_request) in prepared {
        let provider = match provider_gateway::harness_provider_for_definition(
            &state,
            &proof.profile,
            &proof.frozen_definition,
            None,
        )
        .await
        {
            Ok(provider) => provider,
            Err(error) => {
                abort_claimed_compare_attempts(&state.storage, &claimed);
                return Err(error);
            }
        };
        dispatch_ready.push((route, input, provider, provider_request));
    }

    let compare_routes = dispatch_ready
        .iter()
        .map(|(route, input, provider, _)| CompareRoute {
            route_id: route.route_id.clone(),
            provider_id: input.provider_profile_id.clone(),
            model_id: input.model.clone(),
            provider: provider.clone(),
        })
        .collect::<Vec<_>>();
    let execution = match execute_compare(&request.compare_id, frozen, compare_routes, None).await {
        Ok(execution) => execution,
        Err(error) => {
            abort_claimed_compare_attempts(&state.storage, &claimed);
            return Err(error);
        }
    };

    // Persist each terminal result through the same native journal used by a
    // normal prepared run.  Compare output remains in the returned projection,
    // while durable history stores only bounded message/usage facts and hashes.
    // If a persistence step fails, best-effort terminalization prevents another
    // caller from observing a permanently active compare attempt.
    let mut persistence_error = None;
    for attempt in &execution.attempts {
        let Some((_, input, _, _)) = dispatch_ready
            .iter()
            .find(|(route, _, _, _)| route.route_id == attempt.route_id)
        else {
            persistence_error = Some(NativeError::new(
                "compare_execution_scope_conflict",
                "The compare result route is outside the prepared request",
            ));
            break;
        };
        if let Err(error) = persist_compare_attempt_result(&state.storage, input, attempt) {
            persistence_error = Some(error);
            break;
        }
    }
    if let Some(error) = persistence_error {
        for (_, input, _, _) in &dispatch_ready {
            if let Ok(scope) = PreparedRunJournalScope::new(
                input.run_id.clone(),
                input.attempt_id.clone(),
                input.id.clone(),
            ) {
                let _ = state.storage.journal_run_failed_with_class(
                    &scope,
                    "compare_persistence_failed",
                    None,
                    ProviderAttemptFailureEvidence::OutcomeUnknown {
                        acceptance: ProviderAcceptanceEvidence::Unknown,
                    },
                    now_ms(),
                );
            }
        }
        return Err(error);
    }

    let mut attempts = Vec::with_capacity(execution.attempts.len());
    for attempt in execution.attempts {
        let prepared_attempt_id = dispatch_ready
            .iter()
            .find(|(route, _, _, _)| route.route_id == attempt.route_id)
            .map(|(route, _, _, _)| route.attempt_id.clone())
            .ok_or_else(|| {
                NativeError::new(
                    "compare_execution_scope_conflict",
                    "The compare result route is outside the prepared request",
                )
            })?;
        attempts.push(NativeCompareAttemptResult {
            attempt_id: attempt.attempt_id,
            route_id: attempt.route_id,
            prepared_attempt_id,
            provider_id: attempt.provenance.provider_id,
            adapter_id: attempt.provenance.adapter_id,
            model_id: attempt.provenance.model_id,
            status: attempt.status,
            output: attempt.output,
            output_sha256: attempt.output_sha256,
            usage: attempt.usage.into(),
            stop_reason: attempt.stop_reason,
            error_code: attempt.error_code,
        });
    }

    Ok(NativeCompareExecutePreparedResult {
        schema_version: NATIVE_COMPARE_SCHEMA_VERSION,
        compare_id: execution.compare_id,
        logical_input_sha256: execution.logical_input_sha256,
        attempts,
        completed_at_ms: execution.completed_at_ms,
    })
}

/// Folds one in-memory compare result into the durable prepared-attempt
/// lifecycle.  The compare fan-out intentionally batches text in memory, so
/// this helper appends one bounded delta at the terminal boundary rather than
/// pretending that renderer-visible chunks were journaled live.
fn persist_compare_attempt_result(
    storage: &Storage,
    input: &FrozenProviderInput,
    attempt: &CompareAttemptExecution,
) -> NativeResult<()> {
    let scope = PreparedRunJournalScope::new(
        input.run_id.clone(),
        input.attempt_id.clone(),
        input.id.clone(),
    )?;

    match attempt.status {
        CompareAttemptStatus::Completed => {
            let _ = storage.journal_provider_started(
                &scope,
                &input.provider_profile_id,
                &input.model,
                now_ms(),
            )?;
            if let Some(output) = attempt.output() {
                if output.len() > crate::storage::MAX_MESSAGE_BYTES {
                    // The provider has already produced a response, but Omnia
                    // cannot safely persist it in the assistant projection.
                    // Preserve the uncertainty instead of truncating content
                    // and claiming a successful terminal run.
                    let _ = storage.journal_run_failed_with_class(
                        &scope,
                        "compare_output_too_large",
                        None,
                        ProviderAttemptFailureEvidence::OutcomeUnknown {
                            acceptance: ProviderAcceptanceEvidence::Accepted,
                        },
                        now_ms(),
                    )?;
                    return Err(NativeError::new(
                        "compare_output_too_large",
                        "The compare output exceeds the durable assistant-message limit",
                    ));
                }
                if !output.is_empty() {
                    let _ = storage.journal_assistant_delta(&scope, output, now_ms())?;
                }
            }
            let _ = storage.journal_usage(
                &scope,
                ProviderUsageSnapshot {
                    input_tokens: Some(attempt.usage.input_tokens),
                    output_tokens: Some(attempt.usage.output_tokens),
                    cached_input_tokens: Some(attempt.usage.cache_read_tokens),
                    cache_read_input_tokens: Some(attempt.usage.cache_read_tokens),
                    cache_write_input_tokens: Some(attempt.usage.cache_write_tokens),
                    reasoning_tokens: None,
                },
                now_ms(),
            )?;
            let finish_reason = compare_finish_reason(attempt.stop_reason);
            let _ = storage.journal_run_completed(&scope, finish_reason, now_ms())?;
        }
        CompareAttemptStatus::Cancelled => {
            let _ = storage.journal_run_completed(&scope, "cancelled", now_ms())?;
        }
        CompareAttemptStatus::Failed => {
            let error_code = attempt
                .error_code
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or("compare_attempt_unknown");
            let _ = storage.journal_run_failed_with_class(
                &scope,
                error_code,
                None,
                ProviderAttemptFailureEvidence::Definitive {
                    acceptance: ProviderAcceptanceEvidence::NotAccepted,
                },
                now_ms(),
            )?;
        }
        CompareAttemptStatus::Unknown => {
            let error_code = attempt
                .error_code
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or("compare_attempt_unknown");
            let _ = storage.journal_run_failed_with_class(
                &scope,
                error_code,
                None,
                ProviderAttemptFailureEvidence::OutcomeUnknown {
                    acceptance: ProviderAcceptanceEvidence::Accepted,
                },
                now_ms(),
            )?;
        }
    }
    Ok(())
}

fn abort_claimed_compare_attempts(storage: &Storage, claimed: &[(String, String, String)]) {
    for (run_id, attempt_id, input_id) in claimed {
        if let Ok(scope) =
            PreparedRunJournalScope::new(run_id.clone(), attempt_id.clone(), input_id.clone())
        {
            let _ = storage.journal_run_failed_with_class(
                &scope,
                "compare_dispatch_aborted",
                None,
                ProviderAttemptFailureEvidence::Definitive {
                    acceptance: ProviderAcceptanceEvidence::NotAccepted,
                },
                now_ms(),
            );
        }
    }
}

fn compare_finish_reason(reason: Option<StopReason>) -> &'static str {
    match reason {
        Some(StopReason::EndTurn) => "end_turn",
        Some(StopReason::ToolUse) => "tool_use",
        Some(StopReason::MaxTokens) => "max_tokens",
        Some(StopReason::StopSequence) => "stop_sequence",
        Some(StopReason::Refusal) => "refusal",
        Some(StopReason::TurnLimit) => "turn_limit",
        Some(StopReason::Other) | None => "other",
    }
}

/// Converts native frozen messages and an allowlisted parameter subset into
/// the provider-neutral harness request. Provider-specific fields are not
/// accepted by compare dispatch until a typed native bridge exists.
fn provider_request_from_frozen(input: &FrozenProviderInput) -> NativeResult<ProviderRequest> {
    input.validate()?;
    let mut system_parts = Vec::new();
    let mut messages = Vec::new();
    for message in &input.messages {
        match message.role.as_str() {
            "system" | "developer" => system_parts.push(message.content.clone()),
            "user" => messages.push(Message {
                role: Role::User,
                content: vec![Block::text(message.content.clone())],
            }),
            "assistant" => messages.push(Message {
                role: Role::Assistant,
                content: vec![Block::text(message.content.clone())],
            }),
            "tool" => {
                return Err(NativeError::new(
                    "unsupported_message_role",
                    "Prepared compare inputs with tool messages require a typed native bridge",
                ))
            }
            _ => {
                return Err(NativeError::new(
                    "unsupported_message_role",
                    "The prepared compare input contains an unsupported message role",
                ))
            }
        }
    }

    let value: Value = serde_json::from_str(&input.parameters_json).map_err(|_| {
        NativeError::new(
            "prepared_input_integrity_failed",
            "The frozen provider parameters could not be decoded",
        )
    })?;
    let object = value.as_object().ok_or_else(|| {
        NativeError::new(
            "compare_parameter_invalid",
            "Prepared provider parameters must be a JSON object",
        )
    })?;
    let max_tokens = read_u32_alias(object, "maxOutputTokens", "max_output_tokens")?;
    let temperature = read_temperature_alias(object)?;
    let reasoning_effort = read_reasoning_alias(object)?;
    for key in object.keys() {
        if !matches!(
            key.as_str(),
            "maxOutputTokens"
                | "max_output_tokens"
                | "temperature"
                | "reasoningEffort"
                | "reasoning_effort"
        ) {
            return Err(NativeError::new(
                "compare_parameter_unsupported",
                "Prepared compare parameters contain a field without a native harness mapping",
            ));
        }
    }

    Ok(ProviderRequest {
        model: input.model.clone(),
        system: (!system_parts.is_empty()).then(|| system_parts.join("\n\n")),
        messages,
        tools: Vec::new(),
        max_tokens,
        temperature,
        reasoning_effort,
    })
}

fn read_u32_alias(
    object: &serde_json::Map<String, Value>,
    camel: &str,
    snake: &str,
) -> NativeResult<Option<u32>> {
    let value = alias_value(object, camel, snake)?;
    let Some(value) = value else { return Ok(None) };
    let number = value.as_u64().ok_or_else(|| {
        NativeError::new(
            "compare_parameter_invalid",
            "maxOutputTokens must be a positive integer",
        )
    })?;
    let number = u32::try_from(number).map_err(|_| {
        NativeError::new(
            "compare_parameter_invalid",
            "maxOutputTokens exceeds the native harness bound",
        )
    })?;
    if number == 0 {
        return Err(NativeError::new(
            "compare_parameter_invalid",
            "maxOutputTokens must be positive",
        ));
    }
    Ok(Some(number))
}

fn read_temperature_alias(object: &serde_json::Map<String, Value>) -> NativeResult<Option<f32>> {
    let Some(value) = object.get("temperature") else {
        return Ok(None);
    };
    let number = value.as_f64().ok_or_else(|| {
        NativeError::new(
            "compare_parameter_invalid",
            "temperature must be a finite number between 0 and 2",
        )
    })?;
    if !number.is_finite() || !(0.0..=2.0).contains(&number) {
        return Err(NativeError::new(
            "compare_parameter_invalid",
            "temperature must be a finite number between 0 and 2",
        ));
    }
    Ok(Some(number as f32))
}

fn read_reasoning_alias(object: &serde_json::Map<String, Value>) -> NativeResult<Option<String>> {
    let value = alias_value(object, "reasoningEffort", "reasoning_effort")?;
    let Some(value) = value else { return Ok(None) };
    let effort = value.as_str().ok_or_else(|| {
        NativeError::new(
            "compare_parameter_invalid",
            "reasoningEffort must be one of none, minimal, low, medium, high, or max",
        )
    })?;
    if !matches!(
        effort,
        "none" | "minimal" | "low" | "medium" | "high" | "max"
    ) {
        return Err(NativeError::new(
            "compare_parameter_invalid",
            "reasoningEffort must be one of none, minimal, low, medium, high, or max",
        ));
    }
    Ok(Some(effort.to_owned()))
}

fn alias_value<'a>(
    object: &'a serde_json::Map<String, Value>,
    camel: &str,
    snake: &str,
) -> NativeResult<Option<&'a Value>> {
    match (object.get(camel), object.get(snake)) {
        (Some(_), Some(_)) => Err(NativeError::new(
            "compare_parameter_conflict",
            "Prepared compare parameters contain both aliases for one field",
        )),
        (Some(value), None) | (None, Some(value)) => Ok(Some(value)),
        (None, None) => Ok(None),
    }
}

/// Safe provider identity attached to a completed attempt.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompareProvenance {
    pub provider_id: String,
    pub adapter_id: String,
    pub model_id: String,
}

/// Runtime result for one attempt.  `output` is intentionally kept outside
/// [`CompareAttemptReceipt`]; callers may put it in the independent session
/// transcript but it must never cross as part of the merge receipt.
#[derive(Clone)]
pub struct CompareAttemptExecution {
    pub attempt_id: String,
    pub route_id: String,
    pub provenance: CompareProvenance,
    pub status: CompareAttemptStatus,
    pub output: Option<String>,
    pub output_sha256: Option<String>,
    pub usage: Usage,
    pub stop_reason: Option<StopReason>,
    /// A bounded, allowlisted code only.  Provider response text is never
    /// copied into the execution receipt.
    pub error_code: Option<String>,
}

impl std::fmt::Debug for CompareAttemptExecution {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CompareAttemptExecution")
            .field("attempt_id", &self.attempt_id)
            .field("route_id", &self.route_id)
            .field("provenance", &self.provenance)
            .field("status", &self.status)
            .field(
                "output_bytes",
                &self.output.as_ref().map(|output| output.len()),
            )
            .field("output_sha256", &self.output_sha256)
            .field("usage", &self.usage)
            .field("stop_reason", &self.stop_reason)
            .field("error_code", &self.error_code)
            .finish()
    }
}

/// Content free attempt projection embedded in a merge receipt.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompareAttemptReceipt {
    pub attempt_id: String,
    pub route_id: String,
    pub provenance: CompareProvenance,
    pub status: CompareAttemptStatus,
    pub usage: CompareUsageReceipt,
    pub stop_reason: Option<StopReason>,
    pub output_sha256: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompareUsageReceipt {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

impl From<Usage> for CompareUsageReceipt {
    fn from(value: Usage) -> Self {
        Self {
            input_tokens: value.input_tokens,
            output_tokens: value.output_tokens,
            cache_read_tokens: value.cache_read_tokens,
            cache_write_tokens: value.cache_write_tokens,
        }
    }
}

/// Terminal fan out result.  Every attempt is terminal before this value is
/// returned, including cancellation and unknown outcomes.
#[derive(Clone)]
pub struct CompareExecution {
    pub schema_version: u32,
    pub compare_id: String,
    pub logical_input_sha256: String,
    pub attempts: Vec<CompareAttemptExecution>,
    pub completed_at_ms: i64,
    pub merge_receipt: Option<CompareMergeReceipt>,
}

impl std::fmt::Debug for CompareExecution {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CompareExecution")
            .field("schema_version", &self.schema_version)
            .field("compare_id", &self.compare_id)
            .field("logical_input_sha256", &self.logical_input_sha256)
            .field("attempts", &self.attempts)
            .field("completed_at_ms", &self.completed_at_ms)
            .field("merge_receipt", &self.merge_receipt)
            .finish()
    }
}

// Merge helpers remain native contracts under test until a production merge
// command is bound. The prepared compare execution command is compiled normally.
#[cfg(test)]
impl CompareExecution {
    pub fn is_terminal(&self) -> bool {
        self.attempts.iter().all(|attempt| {
            matches!(
                attempt.status,
                CompareAttemptStatus::Completed
                    | CompareAttemptStatus::Failed
                    | CompareAttemptStatus::Cancelled
                    | CompareAttemptStatus::Unknown
            )
        })
    }

    pub fn attempt_ids(&self) -> Vec<String> {
        self.attempts
            .iter()
            .map(|attempt| attempt.attempt_id.clone())
            .collect()
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CompareMergeStrategy {
    BestOf,
    Consensus,
    Manual,
    Weighted,
}

#[cfg(test)]
impl CompareMergeStrategy {
    fn as_str(self) -> &'static str {
        match self {
            Self::BestOf => "best-of",
            Self::Consensus => "consensus",
            Self::Manual => "manual",
            Self::Weighted => "weighted",
        }
    }
}

/// Immutable merge proof.  It contains only hashes, ids, status, route,
/// provenance, usage, and a hashed rationale; raw provider output is absent.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompareMergeReceipt {
    pub schema_version: u32,
    pub compare_id: String,
    pub logical_input_sha256: String,
    pub attempts: Vec<CompareAttemptReceipt>,
    pub attempt_ids: Vec<String>,
    pub selected_attempt_ids: Vec<String>,
    pub strategy: String,
    pub rationale_sha256: String,
    pub final_output_attempt_id: String,
    pub final_output_sha256: String,
    pub created_at_ms: i64,
    pub receipt_sha256: String,
}

/// Runs all selected routes concurrently.  Each route receives a private
/// clone of the frozen request with only its model replaced.  Provider output
/// stays in the returned execution object and is never used to construct the
/// receipt until it has been hashed.
pub async fn execute_compare(
    compare_id: &str,
    input: FrozenCompareInput,
    routes: Vec<CompareRoute>,
    cancellation: Option<CancellationToken>,
) -> NativeResult<CompareExecution> {
    validate_bounded_text("compareId", compare_id, MAX_COMPARE_ID_BYTES)?;
    validate_routes(&routes)?;

    let token = cancellation.unwrap_or_default();
    let futures = routes.into_iter().enumerate().map(|(index, route)| {
        let input = input.clone();
        let token = token.clone();
        let attempt_id = format!("{compare_id}:{}", route.route_id);
        async move { execute_route(index, attempt_id, route, input, token).await }
    });
    let attempts = futures_util::future::join_all(futures).await;
    let attempts = attempts.into_iter().collect::<NativeResult<Vec<_>>>()?;
    Ok(CompareExecution {
        schema_version: NATIVE_COMPARE_SCHEMA_VERSION,
        compare_id: compare_id.to_owned(),
        logical_input_sha256: input.logical_input_sha256.clone(),
        attempts,
        completed_at_ms: now_ms(),
        merge_receipt: None,
    })
}

/// Creates the native merge operation: selecting one or more completed
/// attempts and recording a hash proof.  The final output must be one of the
/// selected attempt outputs; native synthesis can be added later as a
/// separate prepared attempt with its own route and lineage.
#[cfg(test)]
pub fn create_merge_receipt(
    execution: &CompareExecution,
    selected_attempt_ids: &[String],
    strategy: CompareMergeStrategy,
    rationale: &str,
    final_output_attempt_id: &str,
    final_output_sha256: Option<&str>,
) -> NativeResult<CompareMergeReceipt> {
    validate_execution(execution)?;
    if execution.merge_receipt.is_some() {
        return Err(NativeError::new(
            "compare_receipt_immutable",
            "A compare execution already owns an immutable merge receipt",
        ));
    }
    validate_bounded_text("rationale", rationale, MAX_RATIONALE_BYTES)?;
    validate_bounded_text(
        "finalOutputAttemptId",
        final_output_attempt_id,
        MAX_ROUTE_ID_BYTES,
    )?;
    if selected_attempt_ids.is_empty() {
        return Err(NativeError::invalid(
            "selectedAttemptIds",
            "must select at least one completed compare attempt",
        ));
    }
    let attempt_ids = execution.attempt_ids();
    let known = attempt_ids.iter().collect::<BTreeSet<_>>();
    let selected = selected_attempt_ids.iter().collect::<BTreeSet<_>>();
    if selected.len() != selected_attempt_ids.len() || selected.iter().any(|id| !known.contains(id))
    {
        return Err(NativeError::invalid(
            "selectedAttemptIds",
            "must be unique and belong to this compare execution",
        ));
    }
    if strategy == CompareMergeStrategy::BestOf && selected_attempt_ids.len() != 1 {
        return Err(NativeError::invalid(
            "selectedAttemptIds",
            "best-of merge must select exactly one attempt",
        ));
    }
    let final_attempt = execution
        .attempts
        .iter()
        .find(|attempt| attempt.attempt_id == final_output_attempt_id)
        .ok_or_else(|| {
            NativeError::new(
                "compare_output_scope_denied",
                "The final output attempt is not part of the compare execution",
            )
        })?;
    if final_attempt.status != CompareAttemptStatus::Completed
        || !selected_attempt_ids
            .iter()
            .any(|id| id == final_output_attempt_id)
    {
        return Err(NativeError::new(
            "compare_selection_invalid",
            "The final output must be a selected completed attempt",
        ));
    }
    let output_sha256 = match final_output_sha256 {
        Some(value) => {
            validate_sha256("finalOutputSha256", value)?;
            let value = value.to_ascii_lowercase();
            if final_attempt.output_sha256.as_deref() != Some(value.as_str()) {
                return Err(NativeError::new(
                    "compare_output_hash_conflict",
                    "The supplied final output hash does not match the selected attempt",
                ));
            }
            value
        }
        None => final_attempt.output_sha256.clone().ok_or_else(|| {
            NativeError::new(
                "compare_output_missing",
                "The selected final attempt has no finalized output hash",
            )
        })?,
    };
    let mut receipt = CompareMergeReceipt {
        schema_version: NATIVE_COMPARE_SCHEMA_VERSION,
        compare_id: execution.compare_id.clone(),
        logical_input_sha256: execution.logical_input_sha256.clone(),
        attempts: execution
            .attempts
            .iter()
            .map(CompareAttemptReceipt::from)
            .collect(),
        attempt_ids,
        selected_attempt_ids: selected_attempt_ids.to_vec(),
        strategy: strategy.as_str().to_owned(),
        rationale_sha256: sha256_hex(rationale.trim().as_bytes()),
        final_output_attempt_id: final_output_attempt_id.to_owned(),
        final_output_sha256: output_sha256,
        created_at_ms: now_ms(),
        receipt_sha256: String::new(),
    };
    receipt.receipt_sha256 = receipt_hash(&receipt)?;
    Ok(receipt)
}

impl From<&CompareAttemptExecution> for CompareAttemptReceipt {
    fn from(value: &CompareAttemptExecution) -> Self {
        Self {
            attempt_id: value.attempt_id.clone(),
            route_id: value.route_id.clone(),
            provenance: value.provenance.clone(),
            status: value.status,
            usage: value.usage.into(),
            stop_reason: value.stop_reason,
            output_sha256: value.output_sha256.clone(),
            error_code: value.error_code.clone(),
        }
    }
}

impl CompareAttemptExecution {
    /// Returns the runtime output to the owner of the independent attempt
    /// session. This method makes the boundary explicit: receipt builders use
    /// only the hash projection above.
    pub fn output(&self) -> Option<&str> {
        self.output.as_deref()
    }
}

/// Attaches a receipt once. Reattaching the byte-identical receipt is
/// idempotent; a different receipt cannot rewrite a completed comparison.
#[cfg(test)]
pub fn attach_merge_receipt(
    execution: &CompareExecution,
    receipt: CompareMergeReceipt,
) -> NativeResult<CompareExecution> {
    validate_execution(execution)?;
    validate_receipt(&receipt)?;
    if receipt.compare_id != execution.compare_id
        || receipt.logical_input_sha256 != execution.logical_input_sha256
        || receipt.attempt_ids != execution.attempt_ids()
    {
        return Err(NativeError::new(
            "compare_receipt_scope_conflict",
            "The merge receipt does not belong to this compare execution",
        ));
    }
    let expected_attempts = execution
        .attempts
        .iter()
        .map(CompareAttemptReceipt::from)
        .collect::<Vec<_>>();
    if receipt.attempts != expected_attempts {
        return Err(NativeError::new(
            "compare_receipt_scope_conflict",
            "The merge receipt attempt facts do not match the terminal execution",
        ));
    }
    let known = execution.attempt_ids().into_iter().collect::<BTreeSet<_>>();
    let selected = receipt.selected_attempt_ids.iter().collect::<BTreeSet<_>>();
    if selected.len() != receipt.selected_attempt_ids.len()
        || selected.iter().any(|id| !known.contains(*id))
        || !receipt.selected_attempt_ids.iter().all(|id| {
            execution.attempts.iter().any(|attempt| {
                attempt.attempt_id == *id && attempt.status == CompareAttemptStatus::Completed
            })
        })
        || !receipt
            .selected_attempt_ids
            .iter()
            .any(|id| id == &receipt.final_output_attempt_id)
    {
        return Err(NativeError::new(
            "compare_receipt_scope_conflict",
            "The merge receipt selection is not a completed subset of the execution",
        ));
    }
    if receipt.strategy == CompareMergeStrategy::BestOf.as_str()
        && receipt.selected_attempt_ids.len() != 1
    {
        return Err(NativeError::new(
            "compare_receipt_scope_conflict",
            "The best-of merge receipt must select one attempt",
        ));
    }
    let expected_final_hash = execution
        .attempts
        .iter()
        .find(|attempt| attempt.attempt_id == receipt.final_output_attempt_id)
        .and_then(|attempt| attempt.output_sha256.as_deref())
        .ok_or_else(|| {
            NativeError::new(
                "compare_receipt_scope_conflict",
                "The merge receipt final output has no matching attempt hash",
            )
        })?;
    if expected_final_hash != receipt.final_output_sha256 {
        return Err(NativeError::new(
            "compare_receipt_scope_conflict",
            "The merge receipt final output hash does not match the execution",
        ));
    }
    if let Some(existing) = execution.merge_receipt.as_ref() {
        if existing != &receipt {
            return Err(NativeError::new(
                "compare_receipt_immutable",
                "A compare execution already owns a different merge receipt",
            ));
        }
        return Ok(execution.clone());
    }
    let mut attached = execution.clone();
    attached.merge_receipt = Some(receipt);
    Ok(attached)
}

async fn execute_route(
    _index: usize,
    attempt_id: String,
    route: CompareRoute,
    input: FrozenCompareInput,
    cancellation: CancellationToken,
) -> NativeResult<CompareAttemptExecution> {
    let adapter_id = route.provider.id().trim().to_owned();
    validate_bounded_text("adapterId", &adapter_id, MAX_PROVIDER_ID_BYTES).map_err(|_| {
        NativeError::new(
            "compare_adapter_unavailable",
            "The compare route has no bounded provider adapter identity",
        )
    })?;
    let provenance = CompareProvenance {
        provider_id: route.provider_id.clone(),
        adapter_id,
        model_id: route.model_id.clone(),
    };
    let mut request = input.request().clone();
    request.model = route.model_id.clone();
    if cancellation.is_cancelled() {
        return Ok(terminal_attempt(
            attempt_id,
            route.route_id,
            provenance,
            CompareAttemptStatus::Cancelled,
            Usage::default(),
            None,
            Some("cancelled"),
        ));
    }

    let mut stream = match tokio::select! {
        _ = cancellation.cancelled() => {
            return Ok(terminal_attempt(
                attempt_id,
                route.route_id,
                provenance,
                CompareAttemptStatus::Cancelled,
                Usage::default(),
                None,
                Some("cancelled"),
            ));
        }
        result = route.provider.stream(request) => result,
    } {
        Ok(stream) => stream,
        Err(error) => {
            let (status, code) = classify_error(&error, false);
            return Ok(terminal_attempt(
                attempt_id,
                route.route_id,
                provenance,
                status,
                Usage::default(),
                None,
                Some(code),
            ));
        }
    };

    let mut accumulator = MessageAccumulator::default();
    let mut visible_output_bytes = 0usize;
    loop {
        let item = tokio::select! {
            _ = cancellation.cancelled() => {
                return Ok(terminal_attempt(
                    attempt_id,
                    route.route_id,
                    provenance,
                    CompareAttemptStatus::Cancelled,
                    accumulator.usage,
                    accumulator.stop,
                    Some("cancelled"),
                ));
            }
            item = stream.next() => item,
        };
        match item {
            Some(Ok(event)) => {
                if let StreamEvent::TextDelta { text } = &event {
                    visible_output_bytes = visible_output_bytes.saturating_add(text.len());
                    if visible_output_bytes > MAX_OUTPUT_BYTES {
                        return Ok(terminal_attempt(
                            attempt_id,
                            route.route_id,
                            provenance,
                            CompareAttemptStatus::Unknown,
                            accumulator.usage,
                            accumulator.stop,
                            Some("output_too_large"),
                        ));
                    }
                }
                if let Err(_error) = accumulator.push(&event) {
                    let usage = accumulator.usage;
                    let stop = accumulator.stop;
                    return Ok(terminal_attempt(
                        attempt_id,
                        route.route_id,
                        provenance,
                        CompareAttemptStatus::Unknown,
                        usage,
                        stop,
                        Some("stream_protocol_error"),
                    ));
                }
            }
            Some(Err(error)) => {
                let usage = accumulator.usage;
                let stop = accumulator.stop;
                let (status, code) = classify_error(&error, true);
                return Ok(terminal_attempt(
                    attempt_id,
                    route.route_id,
                    provenance,
                    status,
                    usage,
                    stop,
                    Some(code),
                ));
            }
            None => {
                let had_stop = accumulator.stop.is_some();
                let (message, usage, stop) = accumulator.finish();
                let output = visible_text(&message);
                let output_sha256 = Some(sha256_hex(output.as_bytes()));
                let status = if had_stop {
                    CompareAttemptStatus::Completed
                } else {
                    CompareAttemptStatus::Unknown
                };
                return Ok(CompareAttemptExecution {
                    attempt_id,
                    route_id: route.route_id,
                    provenance,
                    status,
                    output: Some(output),
                    output_sha256,
                    usage,
                    stop_reason: Some(stop),
                    error_code: (status == CompareAttemptStatus::Unknown)
                        .then_some("missing_stop_event".to_owned()),
                });
            }
        }
    }
}

fn terminal_attempt(
    attempt_id: String,
    route_id: String,
    provenance: CompareProvenance,
    status: CompareAttemptStatus,
    usage: Usage,
    stop_reason: Option<StopReason>,
    error_code: Option<&str>,
) -> CompareAttemptExecution {
    CompareAttemptExecution {
        attempt_id,
        route_id,
        provenance,
        status,
        // This helper handles early terminal paths, all of which have no
        // finalized output. Successful output is built by execute_route.
        output_sha256: None,
        output: None,
        usage,
        stop_reason,
        error_code: error_code.map(str::to_owned),
    }
}

fn classify_error(
    error: &HarnessError,
    stream_started: bool,
) -> (CompareAttemptStatus, &'static str) {
    match error {
        HarnessError::Cancelled => (CompareAttemptStatus::Cancelled, "cancelled"),
        HarnessError::InvalidInput(_) => (CompareAttemptStatus::Failed, "invalid_input"),
        HarnessError::BudgetExceeded { .. } => (CompareAttemptStatus::Failed, "budget_exceeded"),
        HarnessError::Provider { .. } => {
            if stream_started {
                (CompareAttemptStatus::Unknown, "provider_stream_error")
            } else {
                (CompareAttemptStatus::Failed, "provider_error")
            }
        }
        HarnessError::Protocol(_) => (CompareAttemptStatus::Unknown, "stream_protocol_error"),
        HarnessError::Tool { .. } => (CompareAttemptStatus::Unknown, "tool_error"),
        HarnessError::Io(_) => (CompareAttemptStatus::Unknown, "transport_error"),
        HarnessError::Json(_) => (CompareAttemptStatus::Unknown, "provider_protocol_error"),
    }
}

fn visible_text(message: &Message) -> String {
    let mut output = String::new();
    for block in &message.content {
        if let Block::Text { text } = block {
            output.push_str(text);
        }
    }
    if output.len() > MAX_OUTPUT_BYTES {
        let mut end = MAX_OUTPUT_BYTES;
        while !output.is_char_boundary(end) {
            end -= 1;
        }
        output.truncate(end);
    }
    output
}

fn validate_routes(routes: &[CompareRoute]) -> NativeResult<()> {
    if routes.len() < MIN_COMPARE_ATTEMPTS || routes.len() > MAX_COMPARE_ATTEMPTS {
        return Err(NativeError::invalid(
            "routes",
            "must contain between two and four provider routes",
        ));
    }
    let mut route_ids = BTreeSet::new();
    for route in routes {
        validate_bounded_text("routeId", &route.route_id, MAX_ROUTE_ID_BYTES)?;
        validate_bounded_text("providerId", &route.provider_id, MAX_PROVIDER_ID_BYTES)?;
        validate_bounded_text("modelId", &route.model_id, MAX_MODEL_ID_BYTES)?;
        if !route_ids.insert(route.route_id.clone()) {
            return Err(NativeError::invalid(
                "routes",
                "route and model identities must be unique",
            ));
        }
        if route.provider.id().trim().is_empty() {
            return Err(NativeError::new(
                "compare_adapter_unavailable",
                "A compare route has no provider adapter identity",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
fn validate_execution(execution: &CompareExecution) -> NativeResult<()> {
    if execution.schema_version != NATIVE_COMPARE_SCHEMA_VERSION
        || execution.attempts.len() < MIN_COMPARE_ATTEMPTS
        || execution.attempts.len() > MAX_COMPARE_ATTEMPTS
        || !execution.is_terminal()
    {
        return Err(NativeError::new(
            "compare_execution_invalid",
            "The compare execution is not a valid terminal fan out",
        ));
    }
    validate_sha256("logicalInputSha256", &execution.logical_input_sha256)?;
    let mut ids = BTreeSet::new();
    for attempt in &execution.attempts {
        if !ids.insert(attempt.attempt_id.clone()) {
            return Err(NativeError::new(
                "compare_execution_invalid",
                "Compare attempt identities must be unique",
            ));
        }
        if let Some(output_sha256) = attempt.output_sha256.as_deref() {
            validate_sha256("outputSha256", output_sha256)?;
            if let Some(output) = attempt.output.as_deref() {
                if output.len() > MAX_OUTPUT_BYTES || sha256_hex(output.as_bytes()) != output_sha256
                {
                    return Err(NativeError::new(
                        "compare_execution_integrity_failed",
                        "The compare output hash does not match its bounded output",
                    ));
                }
            }
        } else if attempt.status == CompareAttemptStatus::Completed {
            return Err(NativeError::new(
                "compare_execution_integrity_failed",
                "A completed compare attempt must have an output hash",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
fn validate_receipt(receipt: &CompareMergeReceipt) -> NativeResult<()> {
    if receipt.schema_version != NATIVE_COMPARE_SCHEMA_VERSION {
        return Err(NativeError::new(
            "compare_receipt_invalid",
            "The compare merge receipt schema is unsupported",
        ));
    }
    validate_sha256("logicalInputSha256", &receipt.logical_input_sha256)?;
    validate_sha256("rationaleSha256", &receipt.rationale_sha256)?;
    validate_sha256("finalOutputSha256", &receipt.final_output_sha256)?;
    validate_sha256("receiptSha256", &receipt.receipt_sha256)?;
    if receipt.receipt_sha256 != receipt_hash(receipt)? {
        return Err(NativeError::new(
            "compare_receipt_integrity_failed",
            "The compare merge receipt hash does not match its facts",
        ));
    }
    Ok(())
}

#[cfg(test)]
fn receipt_hash(receipt: &CompareMergeReceipt) -> NativeResult<String> {
    let mut without_hash = receipt.clone();
    without_hash.receipt_sha256.clear();
    let bytes = serde_json::to_vec(&without_hash).map_err(|_| {
        NativeError::new(
            "compare_receipt_failed",
            "Could not serialize the compare merge receipt",
        )
    })?;
    Ok(sha256_hex(&bytes))
}

fn logical_request_bytes(request: &ProviderRequest) -> NativeResult<Vec<u8>> {
    #[derive(Serialize)]
    struct LogicalRequest<'a> {
        system: &'a Option<String>,
        messages: &'a Vec<Message>,
        tools: &'a Vec<omnia_harness::ToolSpec>,
        max_tokens: Option<u32>,
        temperature: Option<f32>,
        reasoning_effort: &'a Option<String>,
    }
    serde_json::to_vec(&LogicalRequest {
        system: &request.system,
        messages: &request.messages,
        tools: &request.tools,
        max_tokens: request.max_tokens,
        temperature: request.temperature,
        reasoning_effort: &request.reasoning_effort,
    })
    .map_err(|_| {
        NativeError::new(
            "compare_input_invalid",
            "The compare request could not be canonicalized",
        )
    })
}

fn validate_bounded_text(field: &'static str, value: &str, max_bytes: usize) -> NativeResult<()> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max_bytes || trimmed.chars().any(char::is_control) {
        return Err(NativeError::invalid(
            field,
            "is empty, malformed, or exceeds its safety limit",
        ));
    }
    Ok(())
}

#[cfg(test)]
fn validate_sha256(field: &'static str, value: &str) -> NativeResult<()> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(NativeError::invalid(field, "must be a SHA-256 hex digest"));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prepared_provider_input::FrozenProviderMessage;
    use async_trait::async_trait;
    use futures_util::stream;
    use omnia_harness::{HarnessResult, ProviderStream, Role, StreamEvent};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    struct FixtureProvider {
        id: &'static str,
        output: &'static str,
        fail: bool,
        delay_ms: u64,
        calls: Arc<AtomicUsize>,
    }

    /// Emits visible output and then loses the provider stream.  The request
    /// has already crossed the provider boundary at this point, so the
    /// compare reducer must classify the attempt as `Unknown` and prevent a
    /// caller from treating the transport failure as a safe replay.
    struct StreamErrorProvider {
        calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl Provider for FixtureProvider {
        fn id(&self) -> &str {
            self.id
        }

        async fn stream(&self, _request: ProviderRequest) -> HarnessResult<ProviderStream> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                return Err(HarnessError::Provider {
                    status: Some(503),
                    message: "fixture failure".to_owned(),
                    retryable: true,
                });
            }
            let output = self.output.to_owned();
            let delay_ms = self.delay_ms;
            let first = stream::once(async move {
                if delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                }
                Ok(StreamEvent::TextDelta { text: output })
            });
            let stop = stream::once(async {
                Ok(StreamEvent::Stop {
                    reason: StopReason::EndTurn,
                })
            });
            Ok(Box::pin(first.chain(stop)))
        }
    }

    #[async_trait]
    impl Provider for StreamErrorProvider {
        fn id(&self) -> &str {
            "fixture-stream-error"
        }

        async fn stream(&self, _request: ProviderRequest) -> HarnessResult<ProviderStream> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(Box::pin(stream::iter(vec![
                Ok(StreamEvent::TextDelta {
                    text: "partial provider output".to_owned(),
                }),
                Err(HarnessError::Provider {
                    status: Some(503),
                    message: "stream dropped after acceptance".to_owned(),
                    retryable: true,
                }),
            ])))
        }
    }

    fn input() -> FrozenCompareInput {
        FrozenCompareInput::freeze(ProviderRequest {
            model: "ignored-by-compare".to_owned(),
            messages: vec![Message::user("same input")],
            ..ProviderRequest::default()
        })
        .expect("freeze input")
    }

    fn route(
        suffix: &str,
        output: &'static str,
        fail: bool,
        calls: Arc<AtomicUsize>,
    ) -> CompareRoute {
        CompareRoute {
            route_id: format!("route-{suffix}"),
            provider_id: format!("provider-{suffix}"),
            model_id: format!("model-{suffix}"),
            provider: Arc::new(FixtureProvider {
                id: "fixture",
                output,
                fail,
                delay_ms: if suffix == "a" { 20 } else { 0 },
                calls,
            }),
        }
    }

    fn stream_error_route(calls: Arc<AtomicUsize>) -> CompareRoute {
        CompareRoute {
            route_id: "route-stream-error".to_owned(),
            provider_id: "provider-stream-error".to_owned(),
            model_id: "model-stream-error".to_owned(),
            provider: Arc::new(StreamErrorProvider { calls }),
        }
    }

    #[test]
    fn logical_digest_excludes_route_models() {
        let first = input();
        let mut changed = first.request.clone();
        changed.model = "another-model".to_owned();
        let second = FrozenCompareInput::freeze(changed).expect("freeze second input");
        assert_eq!(first.logical_input_sha256(), second.logical_input_sha256());
    }

    #[tokio::test]
    async fn fan_out_runs_each_route_and_keeps_independent_facts() {
        let calls = Arc::new(AtomicUsize::new(0));
        let execution = execute_compare(
            "compare-test",
            input(),
            vec![
                route("a", "answer-a", false, calls.clone()),
                route("b", "answer-b", false, calls.clone()),
            ],
            None,
        )
        .await
        .expect("compare execution");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(execution.is_terminal());
        assert_eq!(execution.attempts.len(), 2);
        assert!(execution
            .attempts
            .iter()
            .all(|attempt| attempt.status == CompareAttemptStatus::Completed));
        assert_ne!(execution.attempts[0].output, execution.attempts[1].output);
        assert!(execution.attempts.iter().all(|attempt| {
            attempt.provenance.adapter_id == "fixture" && attempt.output_sha256.is_some()
        }));
    }

    #[tokio::test]
    async fn failed_route_does_not_hide_successful_route() {
        let calls = Arc::new(AtomicUsize::new(0));
        let execution = execute_compare(
            "compare-test",
            input(),
            vec![
                route("a", "answer-a", true, calls.clone()),
                route("b", "answer-b", false, calls.clone()),
            ],
            None,
        )
        .await
        .expect("compare execution");
        assert_eq!(execution.attempts[0].status, CompareAttemptStatus::Failed);
        assert_eq!(
            execution.attempts[0].error_code.as_deref(),
            Some("provider_error")
        );
        assert_eq!(
            execution.attempts[1].status,
            CompareAttemptStatus::Completed
        );
    }

    #[tokio::test]
    async fn accepted_then_stream_failure_is_unknown_and_cannot_be_merged() {
        let calls = Arc::new(AtomicUsize::new(0));
        let execution = execute_compare(
            "compare-test",
            input(),
            vec![
                stream_error_route(calls.clone()),
                route("b", "answer-b", false, calls.clone()),
            ],
            None,
        )
        .await
        .expect("compare execution should terminalize both routes");

        let unknown = execution
            .attempts
            .iter()
            .find(|attempt| attempt.route_id == "route-stream-error")
            .expect("stream-error route should be present");
        assert_eq!(unknown.status, CompareAttemptStatus::Unknown);
        assert_eq!(unknown.error_code.as_deref(), Some("provider_stream_error"));
        assert!(unknown.output.is_none());
        assert!(execution.is_terminal());
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        let error = create_merge_receipt(
            &execution,
            std::slice::from_ref(&unknown.attempt_id),
            CompareMergeStrategy::BestOf,
            "must not select an outcome-unknown attempt",
            &unknown.attempt_id,
            None,
        )
        .expect_err("unknown provider outcome must require reconciliation");
        assert_eq!(error.code, "compare_selection_invalid");
    }

    #[tokio::test]
    async fn cancellation_marks_pending_routes_cancelled() {
        let calls = Arc::new(AtomicUsize::new(0));
        let cancellation = CancellationToken::new();
        let child = cancellation.clone();
        let task = tokio::spawn(async move {
            execute_compare(
                "compare-test",
                input(),
                vec![
                    route("a", "answer-a", false, calls.clone()),
                    route("b", "answer-b", false, calls),
                ],
                Some(child),
            )
            .await
            .expect("compare execution")
        });
        cancellation.cancel();
        let execution = task.await.expect("join compare");
        assert!(execution
            .attempts
            .iter()
            .all(|attempt| attempt.status == CompareAttemptStatus::Cancelled));
    }

    #[tokio::test]
    async fn merge_receipt_is_content_free_and_immutable() {
        let calls = Arc::new(AtomicUsize::new(0));
        let execution = execute_compare(
            "compare-test",
            input(),
            vec![
                route("a", "answer-a", false, calls.clone()),
                route("b", "answer-b", false, calls),
            ],
            None,
        )
        .await
        .expect("compare execution");
        let selected = vec![execution.attempts[0].attempt_id.clone()];
        let receipt = create_merge_receipt(
            &execution,
            &selected,
            CompareMergeStrategy::BestOf,
            "selected by evaluator",
            &selected[0],
            None,
        )
        .expect("merge receipt");
        let serialized = serde_json::to_string(&receipt).expect("serialize receipt");
        assert!(!serialized.contains("answer-a"));
        assert!(!serialized.contains("selected by evaluator"));
        let attached = attach_merge_receipt(&execution, receipt.clone()).expect("attach receipt");
        assert!(attached.merge_receipt.is_some());
        assert_eq!(
            attach_merge_receipt(&attached, receipt)
                .expect("idempotent")
                .merge_receipt,
            attached.merge_receipt
        );
    }

    #[test]
    fn freeze_with_digest_rejects_drift() {
        let request = ProviderRequest {
            messages: vec![Message {
                role: Role::User,
                content: vec![Block::text("hello")],
            }],
            ..ProviderRequest::default()
        };
        let error = FrozenCompareInput::freeze_with_digest(request, &"f".repeat(64))
            .expect_err("digest drift must fail");
        assert_eq!(error.code, "compare_input_digest_conflict");
    }

    fn prepared_input(
        messages: &[FrozenProviderMessage],
        parameters_json: &str,
    ) -> FrozenProviderInput {
        FrozenProviderInput::freeze(crate::prepared_provider_input::FreezeProviderInput {
            id: "provider_input_0123456789abcdef0123456789abcdef",
            attempt_id: "attempt_0123456789abcdef0123456789abcdef",
            run_id: "run_0123456789abcdef0123456789abcdef",
            provider_profile_id: "provider_0123456789abcdef0123456789abcdef",
            model: "model-a",
            messages,
            parameters_json,
            created_at_ms: 1_700_000_000_000,
        })
        .expect("prepared input should freeze")
    }

    #[test]
    fn prepared_input_conversion_keeps_system_and_allowlisted_parameters() {
        let messages = vec![
            FrozenProviderMessage {
                role: "system".into(),
                content: "system policy".into(),
            },
            FrozenProviderMessage {
                role: "developer".into(),
                content: "developer policy".into(),
            },
            FrozenProviderMessage {
                role: "user".into(),
                content: "question".into(),
            },
            FrozenProviderMessage {
                role: "assistant".into(),
                content: "prior answer".into(),
            },
        ];
        let input = prepared_input(
            &messages,
            r#"{"maxOutputTokens":128,"temperature":0.25,"reasoningEffort":"high"}"#,
        );
        let request = provider_request_from_frozen(&input).expect("convert request");
        assert_eq!(request.model, "model-a");
        assert_eq!(
            request.system.as_deref(),
            Some("system policy\n\ndeveloper policy")
        );
        assert_eq!(request.messages.len(), 2);
        assert_eq!(request.max_tokens, Some(128));
        assert_eq!(request.temperature, Some(0.25));
        assert_eq!(request.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn prepared_input_conversion_rejects_tool_roles_and_unknown_parameters() {
        let tool_messages = [FrozenProviderMessage {
            role: "tool".into(),
            content: "tool output".into(),
        }];
        let error = provider_request_from_frozen(&prepared_input(&tool_messages, "{}"))
            .expect_err("tool messages need a typed bridge");
        assert_eq!(error.code, "unsupported_message_role");

        let messages = [FrozenProviderMessage {
            role: "user".into(),
            content: "question".into(),
        }];
        let error = provider_request_from_frozen(&prepared_input(&messages, r#"{"topP":0.5}"#))
            .expect_err("unknown provider fields must fail closed");
        assert_eq!(error.code, "compare_parameter_unsupported");
    }

    #[test]
    fn prepared_input_conversion_rejects_alias_conflicts_and_out_of_range_temperature() {
        let messages = [FrozenProviderMessage {
            role: "user".into(),
            content: "question".into(),
        }];
        let error = provider_request_from_frozen(&prepared_input(
            &messages,
            r#"{"maxOutputTokens":128,"max_output_tokens":256}"#,
        ))
        .expect_err("parameter aliases must not disagree");
        assert_eq!(error.code, "compare_parameter_conflict");

        let error =
            provider_request_from_frozen(&prepared_input(&messages, r#"{"temperature":2.1}"#))
                .expect_err("unsafe temperature must fail closed");
        assert_eq!(error.code, "compare_parameter_invalid");
    }
}
