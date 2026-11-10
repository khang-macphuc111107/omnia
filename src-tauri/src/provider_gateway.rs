#[cfg(test)]
use omnia_harness::provider::destination::is_private_or_local;
#[cfg(test)]
use omnia_harness::provider::destination::DestinationErrorClass;
use omnia_harness::provider::destination::{self, DestinationError};
use std::collections::HashSet;
#[cfg(test)]
use std::net::SocketAddr;

use chrono::{DateTime, Utc};
use dashmap::mapref::entry::Entry;
use futures_util::StreamExt;
use reqwest::{header, Client, RequestBuilder, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::watch;
use url::Url;
use zeroize::Zeroizing;

use crate::provider_definition::FrozenProviderDefinition;
use crate::{
    error::{NativeError, NativeResult, ProviderErrorClass},
    prepared_provider_input::{
        FrozenProviderInput, FrozenProviderMessage, StartPreparedAttemptRequest,
    },
    provider_cache_plan::{ProviderCachePlan, ProviderCachePolicy},
    run_journal::{
        PreparedRunJournalScope, ProviderAcceptanceEvidence, ProviderAttemptFailureEvidence,
        ProviderUsageSnapshot, RunJournalEventRecord,
    },
    secret_store::SecretPurpose,
    state::AppState,
    storage::{now_ms, sha256_hex, ProviderProfileRecord},
};

const RUN_EVENT: &str = "omnia://run-event";
const MAX_MODELS: usize = 2_000;
const MAX_MODEL_ID_BYTES: usize = 512;
const MAX_STREAM_BYTES: usize = 128 * 1024 * 1024;
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
const MAX_COALESCED_DELTA_BYTES: usize = 64 * 1024;
const MAX_ERROR_BODY_BYTES: usize = 256 * 1024;
const MAX_MODEL_CATALOG_BYTES: usize = 16 * 1024 * 1024;
// Retry hints are advisory provider input. Keep the normalized value bounded
// so malformed or hostile headers cannot create an unbounded sleep/deadline in
// a downstream scheduler. Only the normalized duration may cross the native
// boundary; the original header text is never copied into renderer-facing
// diagnostics.
const MAX_RETRY_AFTER_MS: u64 = 24 * 60 * 60 * 1_000;
const ANTHROPIC_VERSION: &str = "2023-06-01";

pub struct ProviderGateway;

impl ProviderGateway {
    pub fn new() -> NativeResult<Self> {
        Ok(Self)
    }

    #[cfg(test)]
    fn client_for_resolved_origin(
        &self,
        host: &str,
        addresses: &[SocketAddr],
    ) -> NativeResult<Client> {
        destination::client_for_resolved_origin(host, addresses).map_err(native_destination_error)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderProfileRequest {
    profile_id: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRunParameters {
    temperature: Option<f64>,
    top_p: Option<f64>,
    top_k: Option<u64>,
    max_output_tokens: Option<u64>,
    seed: Option<i64>,
    stop: Option<Vec<String>>,
    reasoning_effort: Option<String>,
    json_mode: Option<bool>,
    native: Option<Map<String, Value>>,
    cache_policy: Option<ProviderCachePolicy>,
}

impl FrozenProviderInput {
    fn provider_parameters(&self) -> Result<ProviderRunParameters, ProviderFailure> {
        let parameters: ProviderRunParameters = serde_json::from_str(&self.parameters_json)
            .map_err(|_| {
                ProviderFailure::new(
                    "prepared_input_integrity_failed",
                    "The frozen provider parameters could not be decoded",
                )
            })?;
        if let Some(policy) = parameters.cache_policy.as_ref() {
            policy.validate().map_err(native_input_failure)?;
        }
        Ok(parameters)
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub(crate) id: String,
    pub(crate) display_name: String,
    pub(crate) owned_by: Option<String>,
    pub(crate) created_at: Option<i64>,
    pub(crate) capabilities: ProviderModelCapabilities,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelCapabilities {
    pub(crate) streaming: bool,
    pub(crate) tools: Option<bool>,
    pub(crate) vision: Option<bool>,
    pub(crate) reasoning: Option<bool>,
    pub(crate) source: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelList {
    profile_id: String,
    models: Vec<ProviderModel>,
    discovered_at: String,
    snapshot_id: String,
    snapshot_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConnectionHealth {
    profile_id: String,
    healthy: bool,
    latency_ms: u128,
    model_count: usize,
    checked_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum RunStreamEvent {
    Started {
        run_id: String,
        created_at: String,
        provider_profile_id: String,
        model: String,
        journal_events: Vec<RunJournalEventRecord>,
    },
    Delta {
        run_id: String,
        sequence: usize,
        text: String,
        journal_events: Vec<RunJournalEventRecord>,
    },
    ReasoningDelta {
        run_id: String,
        sequence: usize,
        text: String,
        journal_events: Vec<RunJournalEventRecord>,
    },
    Usage {
        run_id: String,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cached_input_tokens: Option<u64>,
        cache_read_input_tokens: Option<u64>,
        cache_write_input_tokens: Option<u64>,
        reasoning_tokens: Option<u64>,
        journal_events: Vec<RunJournalEventRecord>,
    },
    Completed {
        run_id: String,
        finish_reason: String,
        journal_events: Vec<RunJournalEventRecord>,
    },
    Error {
        run_id: String,
        code: String,
        message: String,
        retryable: bool,
        error_class: ProviderErrorClass,
        status: Option<u16>,
        retry_after_ms: Option<u64>,
        journal_events: Vec<RunJournalEventRecord>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProviderFamily {
    /// OpenAI-compatible Chat Completions. This is retained for local and
    /// compatibility gateways whose contract is explicitly message-shaped.
    OpenAi,
    /// First-party OpenAI Responses. Keep this distinct from the compatible
    /// adapter: the request body and SSE event vocabulary are different.
    OpenAiResponses,
    Anthropic,
    Gemini,
}

#[derive(Debug)]
struct ProviderFailure {
    code: &'static str,
    message: String,
    retryable: bool,
    error_class: ProviderErrorClass,
    status: Option<u16>,
    retry_after_ms: Option<u64>,
    acceptance: ProviderAcceptanceEvidence,
}

impl ProviderFailure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            error_class: default_provider_error_class(code),
            status: None,
            retry_after_ms: None,
            acceptance: ProviderAcceptanceEvidence::NotAccepted,
        }
    }

    fn retryable(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: true,
            error_class: default_provider_error_class(code),
            status: None,
            retry_after_ms: None,
            acceptance: ProviderAcceptanceEvidence::NotAccepted,
        }
    }

    fn with_acceptance(mut self, acceptance: ProviderAcceptanceEvidence) -> Self {
        self.acceptance = acceptance;
        self
    }

    fn with_error_class(mut self, error_class: ProviderErrorClass) -> Self {
        self.error_class = error_class;
        self
    }

    fn with_status(mut self, status: StatusCode) -> Self {
        self.status = Some(status.as_u16());
        if self.error_class == ProviderErrorClass::Unknown {
            self.error_class = provider_error_class_for_status(status);
        }
        self
    }

    #[cfg(test)]
    fn with_retry_after(mut self, retry_after_ms: Option<u64>) -> Self {
        self.retry_after_ms = retry_after_ms;
        self
    }
}

#[derive(Default)]
struct NormalizedChunk {
    text: Vec<String>,
    reasoning: Vec<String>,
    usage: Option<NormalizedUsage>,
    finish_reason: Option<String>,
    terminal_marker: Option<ProviderTerminalMarker>,
    remote_error: Option<ProviderFailure>,
}

impl NormalizedChunk {
    fn is_empty_emission(&self) -> bool {
        self.text.is_empty() && self.reasoning.is_empty() && self.usage.is_none()
    }

    fn text_byte_len(&self) -> usize {
        self.text.iter().map(String::len).sum()
    }

    fn reasoning_byte_len(&self) -> usize {
        self.reasoning.iter().map(String::len).sum()
    }

    fn would_exceed_coalesced_budget(&self, incoming: &NormalizedChunk) -> bool {
        let current_text = self.text_byte_len();
        let incoming_text = incoming.text_byte_len();
        if current_text > 0
            && incoming_text > 0
            && current_text.saturating_add(incoming_text) > MAX_COALESCED_DELTA_BYTES
        {
            return true;
        }
        let current_reasoning = self.reasoning_byte_len();
        let incoming_reasoning = incoming.reasoning_byte_len();
        if current_reasoning > 0
            && incoming_reasoning > 0
            && current_reasoning.saturating_add(incoming_reasoning) > MAX_COALESCED_DELTA_BYTES
        {
            return true;
        }
        false
    }

    fn coalesce_emission(&mut self, incoming: NormalizedChunk) {
        for delta in incoming.text {
            if delta.is_empty() {
                continue;
            }
            if let Some(accumulated) = self.text.first_mut() {
                accumulated.push_str(&delta);
            } else {
                self.text.push(delta);
            }
        }
        for delta in incoming.reasoning {
            if delta.is_empty() {
                continue;
            }
            if let Some(accumulated) = self.reasoning.first_mut() {
                accumulated.push_str(&delta);
            } else {
                self.reasoning.push(delta);
            }
        }
        if let Some(usage) = incoming.usage {
            self.usage = Some(usage);
        }
        if let Some(reason) = incoming.finish_reason {
            self.finish_reason = Some(reason);
        }
        if let Some(marker) = incoming.terminal_marker {
            self.terminal_marker = Some(marker);
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProviderTerminalMarker {
    OpenAiDone,
    OpenAiResponsesTerminal,
    AnthropicMessageStop,
    GeminiFinishReason,
}

#[derive(Debug)]
struct ProviderStreamState {
    family: ProviderFamily,
    saw_provider_event: bool,
    finish_reason: Option<String>,
    terminal_marker: Option<ProviderTerminalMarker>,
    latest_usage: Option<NormalizedUsage>,
}

impl ProviderStreamState {
    fn new(family: ProviderFamily) -> Self {
        Self {
            family,
            saw_provider_event: false,
            finish_reason: None,
            terminal_marker: None,
            latest_usage: None,
        }
    }

    /// Provider streaming usage is often split across lifecycle events. For
    /// example, Anthropic sends input/cache counters in `message_start` and
    /// output counters in `message_delta`. Keep the latest event lossless by
    /// carrying forward counters that are omitted from a later snapshot.
    fn merge_usage_snapshot(&mut self, chunk: &mut NormalizedChunk) {
        let Some(current) = chunk.usage.take() else {
            return;
        };
        let merged = match self.latest_usage.as_ref() {
            Some(previous) => merge_normalized_usage(previous, &current),
            None => current,
        };
        self.latest_usage = Some(merged.clone());
        chunk.usage = Some(merged);
    }

    fn observe(&mut self, chunk: &NormalizedChunk) -> Result<(), ProviderFailure> {
        let has_provider_fact = !chunk.text.is_empty()
            || !chunk.reasoning.is_empty()
            || chunk.usage.is_some()
            || chunk.finish_reason.is_some()
            || chunk.terminal_marker.is_some()
            || chunk.remote_error.is_some();
        if !has_provider_fact {
            return Ok(());
        }
        if self.terminal_marker.is_some() {
            return Err(ProviderFailure::new(
                "provider_protocol_error",
                "The provider sent another event after the terminal marker",
            ));
        }
        self.saw_provider_event = true;
        if let Some(reason) = &chunk.finish_reason {
            self.finish_reason = Some(reason.clone());
        }
        if let Some(marker) = chunk.terminal_marker {
            self.terminal_marker = Some(marker);
        }
        Ok(())
    }

    fn finish_reason(self) -> Result<String, ProviderFailure> {
        if !self.saw_provider_event {
            return Err(ProviderFailure::retryable(
                "provider_stream_interrupted",
                "The provider stream ended before any valid event was received",
            ));
        }
        let reason = match self.family {
            ProviderFamily::OpenAi => {
                if self
                    .terminal_marker
                    .is_some_and(|marker| marker != ProviderTerminalMarker::OpenAiDone)
                {
                    return Err(ProviderFailure::new(
                        "provider_protocol_error",
                        "The provider sent terminal evidence for another streaming protocol",
                    ));
                }
                if self.terminal_marker.is_none() && self.finish_reason.is_none() {
                    return Err(ProviderFailure::retryable(
                        "provider_stream_interrupted",
                        "The provider stream ended without a finish reason or terminal marker",
                    ));
                }
                // OpenAI-compatible servers do not all emit `[DONE]`, but a
                // non-null finish reason is still documented semantic terminal
                // evidence. Keep accepting a trailing usage-only chunk before
                // EOF or `[DONE]` so `stream_options.include_usage` remains
                // interoperable.
                self.finish_reason.as_deref().unwrap_or("stop")
            }
            ProviderFamily::OpenAiResponses => {
                if self.terminal_marker != Some(ProviderTerminalMarker::OpenAiResponsesTerminal) {
                    return Err(ProviderFailure::retryable(
                        "provider_stream_interrupted",
                        "The OpenAI Responses stream ended without response.completed or response.incomplete",
                    ));
                }
                self.finish_reason.as_deref().unwrap_or("stop")
            }
            ProviderFamily::Anthropic => {
                if self.terminal_marker != Some(ProviderTerminalMarker::AnthropicMessageStop) {
                    return Err(ProviderFailure::retryable(
                        "provider_stream_interrupted",
                        "The Anthropic stream ended without message_stop",
                    ));
                }
                self.finish_reason.as_deref().ok_or_else(|| {
                    ProviderFailure::new(
                        "provider_protocol_error",
                        "The Anthropic terminal sequence did not include a stop reason",
                    )
                })?
            }
            ProviderFamily::Gemini => {
                if self.terminal_marker != Some(ProviderTerminalMarker::GeminiFinishReason) {
                    return Err(ProviderFailure::retryable(
                        "provider_stream_interrupted",
                        "The Gemini stream ended without a candidate finish reason",
                    ));
                }
                self.finish_reason.as_deref().ok_or_else(|| {
                    ProviderFailure::new(
                        "provider_protocol_error",
                        "The Gemini terminal event did not include a finish reason",
                    )
                })?
            }
        };
        Ok(normalize_finish_reason(reason))
    }
}

#[derive(Clone, Debug)]
struct NormalizedUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    /// Compatibility aggregate.  Provider-specific adapters should also
    /// populate the explicit read/write counters when the wire protocol
    /// exposes them separately.
    cached_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_write_input_tokens: Option<u64>,
    reasoning_tokens: Option<u64>,
}

fn merge_normalized_usage(
    previous: &NormalizedUsage,
    current: &NormalizedUsage,
) -> NormalizedUsage {
    let cache_read_input_tokens = max_optional_u64(
        previous.cache_read_input_tokens,
        current.cache_read_input_tokens,
    );
    let cache_write_input_tokens = max_optional_u64(
        previous.cache_write_input_tokens,
        current.cache_write_input_tokens,
    );
    let cached_input_tokens = max_optional_u64(
        max_optional_u64(previous.cached_input_tokens, current.cached_input_tokens),
        add_optional_u64(cache_read_input_tokens, cache_write_input_tokens),
    );
    NormalizedUsage {
        input_tokens: max_optional_u64(previous.input_tokens, current.input_tokens),
        output_tokens: max_optional_u64(previous.output_tokens, current.output_tokens),
        cached_input_tokens,
        cache_read_input_tokens,
        cache_write_input_tokens,
        reasoning_tokens: max_optional_u64(previous.reasoning_tokens, current.reasoning_tokens),
    }
}

fn max_optional_u64(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

/// Minimal immutable identity required after a provider request has been
/// compiled. Keeping streaming independent from the dispatch IPC payload lets
/// both legacy tests and native-owned prepared inputs share the same runtime
/// without reconstructing renderer-authored messages or parameters.
#[derive(Clone, Debug)]
struct ProviderStreamContext {
    run_id: String,
    attempt_id: String,
    frozen_provider_input_id: String,
    model: String,
}

impl ProviderStreamContext {
    fn journal_scope(&self) -> NativeResult<PreparedRunJournalScope> {
        PreparedRunJournalScope::new(
            &self.run_id,
            &self.attempt_id,
            &self.frozen_provider_input_id,
        )
    }
}

#[tauri::command]
pub async fn provider_connection_test(
    state: State<'_, AppState>,
    request: ProviderProfileRequest,
) -> NativeResult<ProviderConnectionHealth> {
    let started = std::time::Instant::now();
    let profile = state
        .storage
        .get_provider_profile(request.profile_id.trim())?;
    let client = validated_client_for_profile(&state.provider_gateway, &profile).await?;
    let models = discover_models(&state, &client, &profile)
        .await
        .map_err(native_provider_error)?;
    Ok(ProviderConnectionHealth {
        profile_id: profile.id,
        healthy: true,
        latency_ms: started.elapsed().as_millis(),
        model_count: models.len(),
        checked_at: Utc::now().to_rfc3339(),
    })
}

#[tauri::command]
pub async fn provider_models_list(
    state: State<'_, AppState>,
    request: ProviderProfileRequest,
) -> NativeResult<ProviderModelList> {
    let profile = state
        .storage
        .get_provider_profile(request.profile_id.trim())?;
    let client = validated_client_for_profile(&state.provider_gateway, &profile).await?;
    let models = discover_models(&state, &client, &profile)
        .await
        .map_err(native_provider_error)?;
    let models_json = serde_json::to_string(&models).map_err(|_| {
        NativeError::new(
            "provider_catalog_serialization_failed",
            "The sanitized provider catalog could not be serialized",
        )
    })?;
    let snapshot_sha256 = sha256_hex(models_json.as_bytes());
    let snapshot_id_hint = format!("catalog_snapshot_{}", &snapshot_sha256[..32]);
    let discovered_at_ms = now_ms();
    let snapshot_id = state.storage.persist_provider_catalog_snapshot(
        &profile.id,
        &snapshot_id_hint,
        &snapshot_sha256,
        &models_json,
        discovered_at_ms,
    )?;
    Ok(ProviderModelList {
        profile_id: profile.id,
        models,
        discovered_at: Utc::now().to_rfc3339(),
        snapshot_id,
        snapshot_sha256,
    })
}

/// Starts the exact native-owned provider attempt created by
/// `conversation_run_prepare`.
///
/// The renderer supplies only opaque IDs. Messages, parameters, model,
/// provider profile, endpoint, and credentials are resolved exclusively from
/// native storage and protected native services.
#[tauri::command]
pub async fn start_prepared_attempt(
    app: AppHandle,
    state: State<'_, AppState>,
    request: StartPreparedAttemptRequest,
) -> NativeResult<()> {
    // Validate shape before any lookup so malformed renderer input cannot be
    // used to probe storage or terminalize an unrelated run.
    request.validate()?;
    let (input, dispatch_proof) = state
        .storage
        .load_prepared_provider_dispatch_proof(&request)?;
    let run_id = input.run_id.clone();
    let journal_scope = PreparedRunJournalScope::new(&input.run_id, &input.attempt_id, &input.id)?;
    let (cancel_tx, cancel_rx) = watch::channel(false);
    match state.run_cancellations.entry(run_id.clone()) {
        Entry::Vacant(entry) => {
            // Reserve the run synchronously before the first await. A second
            // invocation cannot load the same queued receipt and race this one
            // through provider validation or the exact dispatch transition.
            entry.insert(cancel_tx);
        }
        Entry::Occupied(_) => {
            return Err(NativeError::new(
                "run_already_active",
                "The prepared run is already active",
            ));
        }
    }

    let prepared = async {
        // The live profile proves that this provider remains enabled and
        // owned by the current profile.  Transport fields, however, must come
        // from the immutable definition captured during preparation so URL,
        // adapter, auth scheme, organization/project routing, and local-network
        // authority cannot drift underneath a queued attempt.
        let profile = dispatch_profile_for_definition(
            &dispatch_proof.profile,
            &dispatch_proof.frozen_definition,
        );
        let client = validated_client_for_profile(&state.provider_gateway, &profile).await?;
        let family = provider_family(&profile.provider_type).map_err(native_provider_error)?;
        let credential = load_credential_for_definition(&state, &dispatch_proof.frozen_definition)?;
        let provider_request = build_prepared_stream_request(
            &client,
            family,
            &profile,
            credential.as_deref().map(String::as_str),
            &input,
        )
        .map_err(native_provider_error)?;

        Ok::<_, NativeError>((profile, family, provider_request))
    }
    .await;
    let (profile, family, provider_request) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            state.run_cancellations.remove(&run_id);
            // The loaded input proves exact run ownership. Predispatch failures
            // may therefore terminalize only this run; malformed or unknown
            // receipts returned earlier and never reach this branch.
            let _ = state.storage.journal_prepared_run_failed_with_class(
                &journal_scope,
                error.code,
                error.error_class,
                ProviderAttemptFailureEvidence::Definitive {
                    acceptance: ProviderAcceptanceEvidence::NotAccepted,
                },
                now_ms(),
            );
            return Err(error);
        }
    };

    // The exact transition is the final pre-dispatch step. It binds the queued
    // run, created attempt, and frozen input receipt atomically and protects
    // against replay before the HTTP future can be polled. Keep this outside
    // the predispatch-failure terminalization branch: a state conflict can mean
    // another invocation already dispatched or completed the run, and must
    // never rewrite that durable state to failed.
    if let Err(error) = state.storage.mark_prepared_attempt_dispatching(&request) {
        state.run_cancellations.remove(&run_id);
        return Err(error);
    }

    let stream_context = ProviderStreamContext {
        run_id: run_id.clone(),
        attempt_id: input.attempt_id.clone(),
        frozen_provider_input_id: input.id.clone(),
        model: input.model.clone(),
    };
    let cancellations = state.run_cancellations.clone();
    tauri::async_runtime::spawn(async move {
        let app_state = app.state::<AppState>();
        let result = stream_provider_run(
            &app,
            &app_state.storage,
            &profile,
            family,
            &stream_context,
            provider_request,
            cancel_rx,
        )
        .await;
        if let Err(error) = result {
            let evidence = match error.acceptance {
                ProviderAcceptanceEvidence::Accepted => {
                    ProviderAttemptFailureEvidence::Definitive {
                        acceptance: ProviderAcceptanceEvidence::Accepted,
                    }
                }
                ProviderAcceptanceEvidence::NotAccepted => {
                    ProviderAttemptFailureEvidence::Definitive {
                        acceptance: ProviderAcceptanceEvidence::NotAccepted,
                    }
                }
                ProviderAcceptanceEvidence::Unknown => {
                    ProviderAttemptFailureEvidence::OutcomeUnknown {
                        acceptance: ProviderAcceptanceEvidence::Unknown,
                    }
                }
            };
            let journal_events = stream_context
                .journal_scope()
                .ok()
                .and_then(|scope| {
                    app_state
                        .storage
                        .journal_run_failed_with_class(
                            &scope,
                            error.code,
                            Some(error.error_class),
                            evidence,
                            now_ms(),
                        )
                        .ok()
                })
                .unwrap_or_default();
            emit_event_best_effort(
                &app,
                RunStreamEvent::Error {
                    run_id: run_id.clone(),
                    code: error.code.to_owned(),
                    message: error.message,
                    retryable: error.retryable,
                    error_class: error.error_class,
                    status: error.status,
                    retry_after_ms: error.retry_after_ms,
                    journal_events,
                },
            );
        }
        cancellations.remove(&run_id);
    });
    Ok(())
}

/// Builds the renderer-safe transport projection used by the provider
/// gateway from an immutable native definition.  The live profile contributes
/// only display/diagnostic metadata and timestamps; all request-destination,
/// adapter, auth, routing, and egress fields are historical snapshot values.
/// The credential-store handle remains exclusively in `FrozenProviderDefinition`.
fn dispatch_profile_for_definition(
    live_profile: &ProviderProfileRecord,
    definition: &FrozenProviderDefinition,
) -> ProviderProfileRecord {
    ProviderProfileRecord {
        id: definition.provider_profile_id.clone(),
        provider_type: definition.provider_type.clone(),
        display_name: live_profile.display_name.clone(),
        normalized_base_url: definition.normalized_base_url.clone(),
        auth_scheme: definition.auth_scheme.clone(),
        organization_id: definition.organization_id.clone(),
        remote_project_id: definition.remote_project_id.clone(),
        credential_status: live_profile.credential_status,
        local_network_grant: definition.local_network_grant,
        // The live profile was already loaded through the active-profile
        // query.  Keep this projection enabled for the network gate without
        // copying any mutable profile transport fields into the request.
        enabled: true,
        created_at_ms: live_profile.created_at_ms,
        updated_at_ms: live_profile.updated_at_ms,
    }
}

async fn discover_models(
    state: &AppState,
    client: &Client,
    profile: &ProviderProfileRecord,
) -> Result<Vec<ProviderModel>, ProviderFailure> {
    let family = provider_family(&profile.provider_type)?;
    let credential = load_credential(state, profile)
        .map_err(|error| ProviderFailure::new(error.code, error.message))?;
    let base = parse_base_url(profile)?;
    let request = match family {
        ProviderFamily::OpenAi | ProviderFamily::OpenAiResponses => {
            let url = join_endpoint(&base, "models")?;
            apply_auth(
                client.get(url),
                family,
                profile,
                credential.as_deref().map(String::as_str),
            )?
        }
        ProviderFamily::Anthropic => {
            let url = join_endpoint(&base, "models?limit=1000")?;
            apply_auth(
                client.get(url),
                family,
                profile,
                credential.as_deref().map(String::as_str),
            )?
        }
        ProviderFamily::Gemini => {
            let url = join_endpoint(&base, "models?pageSize=1000")?;
            apply_auth(
                client.get(url),
                family,
                profile,
                credential.as_deref().map(String::as_str),
            )?
        }
    };
    let response = request.send().await.map_err(classify_reqwest_error)?;
    let response = validate_json_response(response).await?;
    let payload = read_bounded_response(
        response,
        MAX_MODEL_CATALOG_BYTES,
        "provider_catalog_too_large",
    )
    .await?;
    let payload: Value = serde_json::from_slice(&payload).map_err(|_| {
        ProviderFailure::new(
            "provider_protocol_error",
            "The provider returned an invalid model catalog",
        )
    })?;
    parse_model_list(family, &payload)
}

async fn stream_provider_run(
    app: &AppHandle,
    storage: &crate::storage::Storage,
    profile: &ProviderProfileRecord,
    family: ProviderFamily,
    context: &ProviderStreamContext,
    provider_request: RequestBuilder,
    mut cancel_rx: watch::Receiver<bool>,
) -> Result<(), ProviderFailure> {
    let scope = context.journal_scope().map_err(native_storage_failure)?;
    let response = tokio::select! {
        _ = cancel_rx.changed() => {
            let journal_events = storage
                .journal_run_completed(&scope, "cancelled", now_ms())
                .map_err(native_storage_failure)?;
            emit_completed(app, &context.run_id, "cancelled", journal_events);
            return Ok(());
        }
        response = provider_request.send() => response
            .map_err(|error| classify_reqwest_error(error).with_acceptance(ProviderAcceptanceEvidence::Unknown))?,
    };
    let response = validate_stream_response(response).await.map_err(|error| {
        if error
            .status
            .is_some_and(|status| (200..300).contains(&status))
        {
            error.with_acceptance(ProviderAcceptanceEvidence::Accepted)
        } else {
            error
        }
    })?;
    let journal_events = storage
        .journal_provider_started(&scope, &profile.id, &context.model, now_ms())
        .map_err(|error| {
            native_storage_failure(error).with_acceptance(ProviderAcceptanceEvidence::Accepted)
        })?;
    emit_event_best_effort(
        app,
        RunStreamEvent::Started {
            run_id: context.run_id.clone(),
            created_at: Utc::now().to_rfc3339(),
            provider_profile_id: profile.id.clone(),
            model: context.model.clone(),
            journal_events,
        },
    );

    let mut stream = response.bytes_stream();
    let mut decoder = SseDecoder::default();
    let mut sequence = 0usize;
    let mut byte_count = 0usize;
    let mut stream_state = ProviderStreamState::new(family);
    loop {
        let item = tokio::select! {
            changed = cancel_rx.changed() => {
                if changed.is_ok() && *cancel_rx.borrow() {
                    let journal_events = storage
                        .journal_run_completed(&scope, "cancelled", now_ms())
                        .map_err(native_storage_failure)?;
                    emit_completed(app, &context.run_id, "cancelled", journal_events);
                    return Ok(());
                }
                continue;
            }
            item = stream.next() => item,
        };
        let Some(item) = item else { break };
        let bytes = item.map_err(|error| {
            classify_reqwest_error(error).with_acceptance(ProviderAcceptanceEvidence::Accepted)
        })?;
        byte_count = byte_count.saturating_add(bytes.len());
        if byte_count > MAX_STREAM_BYTES {
            return Err(ProviderFailure::new(
                "provider_response_too_large",
                "The provider stream exceeded Omnia's safety limit",
            )
            .with_acceptance(ProviderAcceptanceEvidence::Accepted));
        }
        let frames = decoder
            .push(&bytes)
            .map_err(|error| error.with_acceptance(ProviderAcceptanceEvidence::Accepted))?;
        let (batches, frame_error) = coalesce_frames_for_chunk(family, &frames, &mut stream_state);
        for batch in &batches {
            emit_chunk(app, storage, &scope, &mut sequence, batch)
                .map_err(|error| error.with_acceptance(ProviderAcceptanceEvidence::Accepted))?;
        }
        if let Some(error) = frame_error {
            return Err(error.with_acceptance(ProviderAcceptanceEvidence::Accepted));
        }
    }
    decoder
        .finish()
        .map_err(|error| error.with_acceptance(ProviderAcceptanceEvidence::Accepted))?;
    let finish_reason = stream_state
        .finish_reason()
        .map_err(|error| error.with_acceptance(ProviderAcceptanceEvidence::Accepted))?;
    let journal_events = storage
        .journal_run_completed(&scope, &finish_reason, now_ms())
        .map_err(|error| {
            native_storage_failure(error).with_acceptance(ProviderAcceptanceEvidence::Accepted)
        })?;
    emit_completed(app, &context.run_id, &finish_reason, journal_events);
    Ok(())
}

/// Coalesces all complete SSE frames decoded from a single TCP read chunk into
/// bounded emission batches so high-throughput streams (150+ tok/s) perform a
/// single SQLite transaction and IPC emit per network read chunk rather than one
/// per token. Any valid deltas preceding a malformed frame, protocol violation,
/// or remote error frame within the same chunk are preserved in `batches` so
/// callers flush partial progress before failing.
fn coalesce_frames_for_chunk(
    family: ProviderFamily,
    frames: &[SseFrame],
    stream_state: &mut ProviderStreamState,
) -> (Vec<NormalizedChunk>, Option<ProviderFailure>) {
    let mut batches = Vec::new();
    let mut current = NormalizedChunk::default();
    for frame in frames {
        let mut chunk = match normalize_frame(family, frame) {
            Ok(chunk) => chunk,
            Err(error) => {
                if !current.is_empty_emission() {
                    batches.push(current);
                }
                return (batches, Some(error));
            }
        };
        if let Err(error) = stream_state.observe(&chunk) {
            if !current.is_empty_emission() {
                batches.push(current);
            }
            return (batches, Some(error));
        }
        stream_state.merge_usage_snapshot(&mut chunk);
        let remote_error = chunk.remote_error.take();
        if current.would_exceed_coalesced_budget(&chunk) {
            batches.push(std::mem::take(&mut current));
        }
        current.coalesce_emission(chunk);
        if let Some(error) = remote_error {
            if !current.is_empty_emission() {
                batches.push(current);
            }
            return (batches, Some(error));
        }
    }
    if !current.is_empty_emission() {
        batches.push(current);
    }
    (batches, None)
}

fn emit_chunk(
    app: &AppHandle,
    storage: &crate::storage::Storage,
    scope: &PreparedRunJournalScope,
    sequence: &mut usize,
    chunk: &NormalizedChunk,
) -> Result<(), ProviderFailure> {
    for text in &chunk.text {
        let journal_event = storage
            .journal_assistant_delta(scope, text, now_ms())
            .map_err(native_storage_failure)?;
        emit_event_best_effort(
            app,
            RunStreamEvent::Delta {
                run_id: scope.run_id.clone(),
                sequence: *sequence,
                text: text.clone(),
                journal_events: journal_event.into_iter().collect(),
            },
        );
        *sequence += 1;
    }
    for text in &chunk.reasoning {
        let journal_event = storage
            .journal_reasoning_delta(scope, text, now_ms())
            .map_err(native_storage_failure)?;
        emit_event_best_effort(
            app,
            RunStreamEvent::ReasoningDelta {
                run_id: scope.run_id.clone(),
                sequence: *sequence,
                text: text.clone(),
                journal_events: journal_event.into_iter().collect(),
            },
        );
        *sequence += 1;
    }
    if let Some(usage) = &chunk.usage {
        let journal_event = storage
            .journal_usage(
                scope,
                ProviderUsageSnapshot {
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cached_input_tokens: usage.cached_input_tokens,
                    cache_read_input_tokens: usage.cache_read_input_tokens,
                    cache_write_input_tokens: usage.cache_write_input_tokens,
                    reasoning_tokens: usage.reasoning_tokens,
                },
                now_ms(),
            )
            .map_err(native_storage_failure)?;
        emit_event_best_effort(
            app,
            RunStreamEvent::Usage {
                run_id: scope.run_id.clone(),
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cached_input_tokens: usage.cached_input_tokens,
                cache_read_input_tokens: usage.cache_read_input_tokens,
                cache_write_input_tokens: usage.cache_write_input_tokens,
                reasoning_tokens: usage.reasoning_tokens,
                journal_events: vec![journal_event],
            },
        );
    }
    Ok(())
}

fn emit_event_best_effort(app: &AppHandle, event: RunStreamEvent) {
    if app.emit(RUN_EVENT, event).is_err() {
        // Renderer delivery is advisory. The durable journal and projections
        // are the source of truth and can be replayed after reconnect/restart.
        eprintln!(
            "Omnia renderer event delivery was unavailable; durable journal retained the fact"
        );
    }
}

fn emit_completed(
    app: &AppHandle,
    run_id: &str,
    finish_reason: &str,
    journal_events: Vec<RunJournalEventRecord>,
) {
    emit_event_best_effort(
        app,
        RunStreamEvent::Completed {
            run_id: run_id.to_owned(),
            finish_reason: normalize_finish_reason(finish_reason),
            journal_events,
        },
    );
}

/// Builds a provider request exclusively from a native-owned frozen input.
///
/// The dispatch IPC is intentionally unable to supply messages, parameters,
/// model names, provider profiles, URLs, or credentials.  Callers must first
/// load and validate the frozen record from storage, including its exact
/// attempt and input IDs, before reaching this translation boundary.
fn build_prepared_stream_request(
    client: &Client,
    family: ProviderFamily,
    profile: &ProviderProfileRecord,
    credential: Option<&str>,
    input: &FrozenProviderInput,
) -> Result<RequestBuilder, ProviderFailure> {
    input.validate().map_err(native_input_failure)?;
    if input.provider_profile_id != profile.id {
        return Err(ProviderFailure::new(
            "prepared_input_scope_conflict",
            "The frozen provider input belongs to another provider profile",
        ));
    }
    let parameters = input.provider_parameters()?;
    let cache_plan = ProviderCachePlan::compile_from_parameters_json(
        &input.parameters_json,
        &profile.id,
        &input.model,
        &input.content_sha256,
        &profile.provider_type,
        &input.messages,
    )
    .map_err(native_input_failure)?;
    let base = parse_base_url(profile)?;
    let (endpoint, body) = match family {
        ProviderFamily::OpenAi => (
            join_endpoint(&base, "chat/completions")?,
            build_openai_prepared_body(input, &parameters)?,
        ),
        ProviderFamily::OpenAiResponses => (
            join_endpoint(&base, "responses")?,
            build_openai_responses_prepared_body(input, &parameters)?,
        ),
        ProviderFamily::Anthropic => (
            join_endpoint(&base, "messages")?,
            build_anthropic_prepared_body_with_cache_plan(input, &parameters, cache_plan.as_ref())?,
        ),
        ProviderFamily::Gemini => {
            let model = gemini_model_path(&input.model)?;
            (
                join_endpoint(
                    &base,
                    &format!("models/{model}:streamGenerateContent?alt=sse"),
                )?,
                build_gemini_prepared_body(input, &parameters)?,
            )
        }
    };
    apply_auth(
        client.post(endpoint).json(&body),
        family,
        profile,
        credential,
    )
}

fn build_openai_prepared_body(
    input: &FrozenProviderInput,
    parameters: &ProviderRunParameters,
) -> Result<Value, ProviderFailure> {
    build_openai_body_parts(&input.model, &input.messages, parameters)
}

/// Compiles the frozen text-message input to the first-party OpenAI Responses
/// request shape.  Responses accepts the same role/content message list as a
/// migration bridge, but uses `input`, `max_output_tokens`, `reasoning`, and
/// `text.format` rather than the Chat Completions field names.
fn build_openai_responses_prepared_body(
    input: &FrozenProviderInput,
    parameters: &ProviderRunParameters,
) -> Result<Value, ProviderFailure> {
    let mut body = Map::new();
    body.insert("model".into(), Value::String(input.model.clone()));
    body.insert("stream".into(), Value::Bool(true));
    body.insert("store".into(), Value::Bool(false));
    body.insert(
        "input".into(),
        serde_json::to_value(&input.messages).map_err(|_| {
            ProviderFailure::new(
                "provider_payload_compile_failed",
                "The provider messages could not be serialized",
            )
        })?,
    );
    if parameters.top_k.is_some() {
        return Err(unsupported_parameter("topK", "OpenAI Responses"));
    }
    if parameters.seed.is_some() {
        return Err(unsupported_parameter("seed", "OpenAI Responses"));
    }
    if parameters.stop.is_some() {
        return Err(unsupported_parameter("stop", "OpenAI Responses"));
    }
    insert_number(&mut body, "temperature", parameters.temperature)?;
    insert_number(&mut body, "top_p", parameters.top_p)?;
    insert_u64(&mut body, "max_output_tokens", parameters.max_output_tokens);
    if let Some(reasoning_effort) = &parameters.reasoning_effort {
        body.insert(
            "reasoning".into(),
            json!({"effort": validate_reasoning_effort(reasoning_effort)?}),
        );
    }
    if parameters.json_mode == Some(true) {
        body.insert("text".into(), json!({"format": {"type": "json_object"}}));
    }
    merge_native(
        &mut body,
        &parameters.native,
        openai_responses_reserved_keys(),
    )?;
    Ok(Value::Object(body))
}

#[cfg(test)]
fn build_anthropic_prepared_body(
    input: &FrozenProviderInput,
    parameters: &ProviderRunParameters,
) -> Result<Value, ProviderFailure> {
    build_anthropic_prepared_body_with_cache_plan(input, parameters, None)
}

fn build_anthropic_prepared_body_with_cache_plan(
    input: &FrozenProviderInput,
    parameters: &ProviderRunParameters,
    cache_plan: Option<&ProviderCachePlan>,
) -> Result<Value, ProviderFailure> {
    build_anthropic_body_parts_with_cache_plan(
        &input.model,
        &input.messages,
        parameters,
        cache_plan,
    )
}

fn build_gemini_prepared_body(
    input: &FrozenProviderInput,
    parameters: &ProviderRunParameters,
) -> Result<Value, ProviderFailure> {
    build_gemini_body_parts(&input.messages, parameters)
}

fn build_openai_body_parts<M: Serialize>(
    model: &str,
    messages: &[M],
    parameters: &ProviderRunParameters,
) -> Result<Value, ProviderFailure> {
    let mut body = Map::new();
    body.insert("model".into(), Value::String(model.to_owned()));
    body.insert("stream".into(), Value::Bool(true));
    body.insert("stream_options".into(), json!({"include_usage": true}));
    body.insert(
        "messages".into(),
        serde_json::to_value(messages).map_err(|_| {
            ProviderFailure::new(
                "provider_payload_compile_failed",
                "The provider messages could not be serialized",
            )
        })?,
    );
    if parameters.top_k.is_some() {
        return Err(unsupported_parameter("topK", "OpenAI Chat Completions"));
    }
    insert_number(&mut body, "temperature", parameters.temperature)?;
    insert_number(&mut body, "top_p", parameters.top_p)?;
    insert_u64(&mut body, "max_tokens", parameters.max_output_tokens);
    if let Some(seed) = parameters.seed {
        body.insert("seed".into(), json!(seed));
    }
    if let Some(stop) = validated_stop(&parameters.stop)? {
        body.insert(
            "stop".into(),
            serde_json::to_value(stop).unwrap_or_default(),
        );
    }
    if let Some(reasoning_effort) = &parameters.reasoning_effort {
        body.insert(
            "reasoning_effort".into(),
            Value::String(validate_reasoning_effort(reasoning_effort)?),
        );
    }
    if parameters.json_mode == Some(true) {
        body.insert("response_format".into(), json!({"type":"json_object"}));
    }
    merge_native(&mut body, &parameters.native, openai_reserved_keys())?;
    Ok(Value::Object(body))
}

fn build_anthropic_body_parts_with_cache_plan(
    model: &str,
    input_messages: &[FrozenProviderMessage],
    parameters: &ProviderRunParameters,
    cache_plan: Option<&ProviderCachePlan>,
) -> Result<Value, ProviderFailure> {
    let mut body = Map::new();
    body.insert("model".into(), Value::String(model.to_owned()));
    body.insert("stream".into(), Value::Bool(true));
    let requested_effort = parameters
        .reasoning_effort
        .as_deref()
        .map(validate_reasoning_effort)
        .transpose()?;
    let thinking_effort = requested_effort
        .as_deref()
        .filter(|effort| *effort != "none");
    let thinking_mode = thinking_effort.map(|_| anthropic_thinking_mode(model));
    let thinking_budget = match (thinking_effort, thinking_mode) {
        (Some(effort), Some(AnthropicThinkingMode::Legacy)) => Some(reasoning_budget(effort)),
        _ => None,
    };
    let max_tokens = match (parameters.max_output_tokens, thinking_budget) {
        (Some(max_tokens), Some(thinking_budget)) if max_tokens <= thinking_budget => {
            return Err(ProviderFailure::new(
                "invalid_parameter",
                "maxOutputTokens must be greater than the Anthropic thinking budget",
            ));
        }
        (Some(max_tokens), _) => max_tokens,
        (None, Some(thinking_budget)) => thinking_budget.saturating_add(1_024),
        (None, None) => 4_096,
    };
    body.insert("max_tokens".into(), json!(max_tokens));
    let mut system = Vec::new();
    let mut messages = Vec::new();
    for message in input_messages {
        match message.role.as_str() {
            "system" | "developer" => system.push(message.content.clone()),
            "user" | "assistant" => messages.push(json!({
                "role": message.role,
                "content": message.content,
            })),
            _ => {
                return Err(ProviderFailure::new(
                    "unsupported_message_role",
                    "Anthropic chat currently supports system, developer, user, and assistant text messages",
                ))
            }
        }
    }
    if !system.is_empty() {
        let system_text = system.join("\n\n");
        if cache_plan
            .map(|plan| plan.explicit_anthropic_system)
            .unwrap_or(false)
        {
            body.insert(
                "system".into(),
                Value::Array(vec![anthropic_cache_text_block(
                    system_text,
                    cache_plan.and_then(|plan| plan.anthropic_ttl.as_deref()),
                )]),
            );
        } else {
            body.insert("system".into(), Value::String(system_text));
        }
    }
    if cache_plan
        .map(|plan| plan.explicit_anthropic_last_message)
        .unwrap_or(false)
    {
        let target_index = if cache_plan
            .map(|plan| plan.explicit_anthropic_last_user)
            .unwrap_or(false)
        {
            messages
                .iter()
                .rposition(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        } else {
            messages.len().checked_sub(1)
        };
        if let Some(index) = target_index {
            let last_message = &mut messages[index];
            let content = last_message
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ProviderFailure::new(
                        "provider_payload_compile_failed",
                        "The Anthropic message content could not be converted to a cache block",
                    )
                })?
                .to_owned();
            last_message["content"] = Value::Array(vec![anthropic_cache_text_block(
                content,
                cache_plan.and_then(|plan| plan.anthropic_ttl.as_deref()),
            )]);
        }
    }
    body.insert("messages".into(), Value::Array(messages));
    insert_number(&mut body, "temperature", parameters.temperature)?;
    insert_number(&mut body, "top_p", parameters.top_p)?;
    insert_u64(&mut body, "top_k", parameters.top_k);
    if let Some(stop) = validated_stop(&parameters.stop)? {
        body.insert(
            "stop_sequences".into(),
            serde_json::to_value(stop).unwrap_or_default(),
        );
    }
    if parameters.seed.is_some() {
        return Err(unsupported_parameter("seed", "Anthropic"));
    }
    if parameters.json_mode == Some(true) {
        return Err(unsupported_parameter("jsonMode", "Anthropic text chat"));
    }
    if let (Some(effort), Some(mode)) = (thinking_effort, thinking_mode) {
        match mode {
            AnthropicThinkingMode::Adaptive => {
                body.insert("thinking".into(), json!({"type": "adaptive"}));
                body.insert(
                    "output_config".into(),
                    json!({"effort": anthropic_adaptive_effort(effort)}),
                );
            }
            AnthropicThinkingMode::Legacy => {
                body.insert(
                    "thinking".into(),
                    json!({
                        "type": "enabled",
                        "budget_tokens": reasoning_budget(effort)
                    }),
                );
            }
        }
    }
    merge_native(&mut body, &parameters.native, anthropic_reserved_keys())?;
    Ok(Value::Object(body))
}

fn anthropic_cache_text_block(text: String, ttl: Option<&str>) -> Value {
    let mut block = Map::new();
    block.insert("type".into(), Value::String("text".to_owned()));
    block.insert("text".into(), Value::String(text));
    let mut cache_control = Map::new();
    cache_control.insert("type".into(), Value::String("ephemeral".to_owned()));
    if let Some(ttl) = ttl {
        cache_control.insert("ttl".into(), Value::String(ttl.to_owned()));
    }
    block.insert("cache_control".into(), Value::Object(cache_control));
    Value::Object(block)
}

fn build_gemini_body_parts(
    input_messages: &[FrozenProviderMessage],
    parameters: &ProviderRunParameters,
) -> Result<Value, ProviderFailure> {
    let mut body = Map::new();
    let mut system = Vec::new();
    let mut contents = Vec::new();
    for message in input_messages {
        match message.role.as_str() {
            "system" | "developer" => system.push(message.content.clone()),
            "user" | "assistant" => contents.push(json!({
                "role": if message.role == "assistant" { "model" } else { "user" },
                "parts": [{"text": message.content}],
            })),
            _ => {
                return Err(ProviderFailure::new(
                    "unsupported_message_role",
                    "Gemini chat currently supports system, developer, user, and assistant text messages",
                ))
            }
        }
    }
    if !system.is_empty() {
        body.insert(
            "systemInstruction".into(),
            json!({"parts":[{"text":system.join("\n\n")}] }),
        );
    }
    body.insert("contents".into(), Value::Array(contents));
    let mut generation = Map::new();
    insert_number(&mut generation, "temperature", parameters.temperature)?;
    insert_number(&mut generation, "topP", parameters.top_p)?;
    insert_u64(&mut generation, "topK", parameters.top_k);
    insert_u64(
        &mut generation,
        "maxOutputTokens",
        parameters.max_output_tokens,
    );
    if let Some(stop) = validated_stop(&parameters.stop)? {
        generation.insert(
            "stopSequences".into(),
            serde_json::to_value(stop).unwrap_or_default(),
        );
    }
    if parameters.json_mode == Some(true) {
        generation.insert(
            "responseMimeType".into(),
            Value::String("application/json".into()),
        );
    }
    if let Some(effort) = &parameters.reasoning_effort {
        let budget = reasoning_budget(validate_reasoning_effort(effort)?.as_str());
        generation.insert("thinkingConfig".into(), json!({"thinkingBudget": budget}));
    }
    if parameters.seed.is_some() {
        return Err(unsupported_parameter("seed", "Gemini"));
    }
    if !generation.is_empty() {
        body.insert("generationConfig".into(), Value::Object(generation));
    }
    merge_native(&mut body, &parameters.native, gemini_reserved_keys())?;
    Ok(Value::Object(body))
}

fn apply_auth(
    mut request: RequestBuilder,
    family: ProviderFamily,
    profile: &ProviderProfileRecord,
    credential: Option<&str>,
) -> Result<RequestBuilder, ProviderFailure> {
    let auth_scheme = normalize_identifier(&profile.auth_scheme);
    match (family, auth_scheme.as_str(), credential) {
        (_, "none", None) => {}
        (_, "none", Some(_)) => {
            return Err(ProviderFailure::new(
                "invalid_provider_profile",
                "An unauthenticated provider cannot use a saved credential",
            ))
        }
        (ProviderFamily::Anthropic, "api_key_header", Some(secret)) => {
            request = request
                .header("x-api-key", secret)
                .header("anthropic-version", ANTHROPIC_VERSION);
        }
        (ProviderFamily::Anthropic, "bearer", Some(secret)) => {
            request = request
                .bearer_auth(secret)
                .header("anthropic-version", ANTHROPIC_VERSION);
        }
        (ProviderFamily::Gemini, "api_key_header", Some(secret)) => {
            request = request.header("x-goog-api-key", secret);
        }
        (
            ProviderFamily::OpenAi | ProviderFamily::OpenAiResponses,
            "api_key_header",
            Some(secret),
        ) => {
            request = request.header("api-key", secret);
        }
        (ProviderFamily::OpenAi | ProviderFamily::OpenAiResponses, "bearer", Some(secret)) => {
            request = request.bearer_auth(secret);
        }
        (_, _, Some(_)) => {
            return Err(ProviderFailure::new(
                "unsupported_auth_scheme",
                "The provider authentication scheme is not supported by this native adapter",
            ))
        }
        (_, _, None) => {
            return Err(ProviderFailure::new(
                "secret_missing",
                "The provider credential is missing",
            ))
        }
    }
    // Organization/project headers are OpenAI-specific routing metadata.  The
    // OpenAI wire adapter is also used for local endpoints, so checking only
    // `family == OpenAi` would disclose these values to arbitrary local or
    // compatible servers.  Fail closed unless the provider type explicitly
    // opts into the OpenAI header contract.
    let supports_openai_scope_headers = matches!(
        normalize_identifier(&profile.provider_type).as_str(),
        "openai" | "openai_compatible"
    );
    if (profile.organization_id.is_some() || profile.remote_project_id.is_some())
        && !supports_openai_scope_headers
    {
        return Err(ProviderFailure::new(
            "invalid_provider_profile",
            "OpenAI organization and project metadata is only supported by OpenAI-compatible providers",
        ));
    }
    if supports_openai_scope_headers {
        if let Some(organization) = &profile.organization_id {
            request = request.header("OpenAI-Organization", organization);
        }
        if let Some(project) = &profile.remote_project_id {
            request = request.header("OpenAI-Project", project);
        }
    }
    Ok(request.header(header::ACCEPT, "text/event-stream, application/json"))
}

async fn validate_json_response(response: Response) -> Result<Response, ProviderFailure> {
    let response = validate_http_status(response).await?;
    validate_content_type(&response, "application/json")?;
    Ok(response)
}

async fn validate_stream_response(response: Response) -> Result<Response, ProviderFailure> {
    let response = validate_http_status(response).await?;
    validate_content_type(&response, "text/event-stream")?;
    Ok(response)
}

async fn validate_http_status(response: Response) -> Result<Response, ProviderFailure> {
    let status = response.status();
    if status.is_redirection() {
        return Err(ProviderFailure::new(
            "provider_redirect_blocked",
            "The provider attempted a redirect; Omnia does not forward credentials across redirects",
        )
        .with_status(status));
    }
    if status.is_success() && status != StatusCode::NO_CONTENT {
        return Ok(response);
    }
    let request_id = provider_request_id(response.headers());
    let retry_after = response
        .headers()
        .get(header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            value.len() <= 128
                && value
                    .chars()
                    .all(|character| character.is_ascii_graphic() || character == ' ')
        })
        .map(str::to_owned);
    // Once an HTTP error response has been received, a body read failure must
    // not be treated as a definitive rejection. The provider may have accepted
    // or billed the request before the connection broke, so preserve the
    // outcome-unknown evidence at this boundary.
    let body = read_bounded_response(response, MAX_ERROR_BODY_BYTES, "provider_error_too_large")
        .await
        .map_err(|error| error.with_acceptance(ProviderAcceptanceEvidence::Unknown))?;
    let body = String::from_utf8_lossy(&body);
    let detail = safe_provider_error_message(&body);
    let mut message = match status.as_u16() {
        401 | 403 => "The provider rejected the saved credential or access policy".to_owned(),
        404 => "The provider endpoint or requested resource was not found".to_owned(),
        408 | 429 => "The provider is temporarily busy or rate-limited the request".to_owned(),
        400..=499 => "The provider rejected the request".to_owned(),
        _ => "The provider is temporarily unavailable".to_owned(),
    };
    if let Some(detail) = detail {
        message.push_str(": ");
        message.push_str(&detail);
    }
    if let Some(request_id) = request_id {
        message.push_str(" (request ID ");
        message.push_str(&request_id);
        message.push(')');
    }
    let retry_after_ms = retry_after.as_deref().and_then(parse_retry_after_ms);
    // Never copy the provider-controlled header value into renderer-facing
    // text.  Even though the header is bounded above, it can still contain
    // misleading or sensitive-looking text.  The normalized duration is the
    // only retry hint that crosses the boundary; the original header remains
    // native-only diagnostic input.
    if let Some(retry_after_ms) = retry_after_ms {
        message.push_str("; retry after ");
        message.push_str(&retry_after_ms.to_string());
        message.push_str(" ms");
    }
    let retryable = matches!(status.as_u16(), 408 | 409 | 425 | 429 | 500..=599);
    Err(ProviderFailure {
        code: if retryable {
            "provider_temporarily_unavailable"
        } else {
            "provider_request_rejected"
        },
        message,
        retryable,
        error_class: provider_error_class_for_status(status),
        status: Some(status.as_u16()),
        retry_after_ms,
        acceptance: if retryable {
            ProviderAcceptanceEvidence::Unknown
        } else {
            ProviderAcceptanceEvidence::NotAccepted
        },
    })
}

fn provider_error_class_for_status(status: StatusCode) -> ProviderErrorClass {
    match status {
        StatusCode::UNAUTHORIZED => ProviderErrorClass::Authentication,
        StatusCode::FORBIDDEN => ProviderErrorClass::Authorization,
        StatusCode::PAYMENT_REQUIRED => ProviderErrorClass::Billing,
        StatusCode::NOT_FOUND => ProviderErrorClass::ModelUnavailable,
        StatusCode::REQUEST_TIMEOUT => ProviderErrorClass::Timeout,
        StatusCode::TOO_MANY_REQUESTS | StatusCode::CONFLICT | StatusCode::TOO_EARLY => {
            ProviderErrorClass::RateLimit
        }
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => ProviderErrorClass::Schema,
        status if status.is_server_error() => ProviderErrorClass::Transport,
        _ => ProviderErrorClass::Unknown,
    }
}

fn validate_content_type(
    response: &Response,
    expected_essence: &'static str,
) -> Result<(), ProviderFailure> {
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if content_type.is_some_and(|value| value.eq_ignore_ascii_case(expected_essence)) {
        return Ok(());
    }
    Err(ProviderFailure::new(
        "provider_protocol_error",
        if expected_essence == "text/event-stream" {
            "The provider did not return an SSE response"
        } else {
            "The provider did not return a JSON response"
        },
    )
    .with_status(response.status()))
}

async fn read_bounded_response(
    response: Response,
    limit: usize,
    overflow_code: &'static str,
) -> Result<Vec<u8>, ProviderFailure> {
    if response
        .content_length()
        .is_some_and(|content_length| content_length > limit as u64)
    {
        return Err(ProviderFailure::new(
            overflow_code,
            "The provider response exceeded Omnia's safety limit",
        ));
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(classify_reqwest_error)?;
        // `reqwest` allocates each network chunk before this function sees it.
        // Reject an oversized chunk before reserving/appending to our bounded
        // accumulator, and use fallible reservation so an adversarial stream
        // cannot trigger an unbounded Vec growth path.
        if chunk.len() > limit {
            return Err(ProviderFailure::new(
                overflow_code,
                "The provider response exceeded Omnia's safety limit",
            ));
        }
        let new_len = bytes.len().checked_add(chunk.len()).ok_or_else(|| {
            ProviderFailure::new(
                overflow_code,
                "The provider response exceeded Omnia's safety limit",
            )
        })?;
        if new_len > limit {
            return Err(ProviderFailure::new(
                overflow_code,
                "The provider response exceeded Omnia's safety limit",
            ));
        }
        bytes.try_reserve_exact(chunk.len()).map_err(|_| {
            ProviderFailure::new(
                overflow_code,
                "The provider response exceeded Omnia's safety limit",
            )
        })?;
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn normalize_frame(
    family: ProviderFamily,
    frame: &SseFrame,
) -> Result<NormalizedChunk, ProviderFailure> {
    if frame.data.trim().is_empty() {
        return Ok(NormalizedChunk::default());
    }
    if frame.data.trim() == "[DONE]" {
        return if family == ProviderFamily::OpenAi {
            Ok(NormalizedChunk {
                terminal_marker: Some(ProviderTerminalMarker::OpenAiDone),
                ..Default::default()
            })
        } else {
            Err(ProviderFailure::new(
                "provider_protocol_error",
                "The provider sent an OpenAI terminal marker for another streaming protocol",
            ))
        };
    }
    let value: Value = serde_json::from_str(frame.data.trim()).map_err(|_| {
        ProviderFailure::new(
            "provider_protocol_error",
            "The provider sent an invalid streaming event",
        )
    })?;
    match family {
        ProviderFamily::OpenAi => normalize_openai_event(&value),
        ProviderFamily::OpenAiResponses => {
            normalize_openai_responses_event(frame.event.as_deref(), &value)
        }
        ProviderFamily::Anthropic => normalize_anthropic_event(frame.event.as_deref(), &value),
        ProviderFamily::Gemini => normalize_gemini_event(&value),
    }
}

fn normalize_openai_event(value: &Value) -> Result<NormalizedChunk, ProviderFailure> {
    if let Some(error) = value.get("error") {
        return Ok(NormalizedChunk {
            remote_error: Some(json_remote_error(error)),
            ..Default::default()
        });
    }
    let mut chunk = NormalizedChunk::default();
    for choice in value
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(text) = choice.pointer("/delta/content").and_then(Value::as_str) {
            if !text.is_empty() {
                chunk.text.push(text.to_owned());
            }
        }
        if let Some(text) = choice
            .pointer("/delta/reasoning_content")
            .and_then(Value::as_str)
        {
            if !text.is_empty() {
                chunk.reasoning.push(text.to_owned());
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            chunk.finish_reason = Some(reason.to_owned());
        }
    }
    if let Some(usage) = value.get("usage") {
        chunk.usage = Some(NormalizedUsage {
            input_tokens: u64_field(usage, &["prompt_tokens", "input_tokens"]),
            output_tokens: u64_field(usage, &["completion_tokens", "output_tokens"]),
            cached_input_tokens: usage
                .pointer("/prompt_tokens_details/cached_tokens")
                .and_then(Value::as_u64),
            cache_read_input_tokens: usage
                .pointer("/prompt_tokens_details/cached_tokens")
                .and_then(Value::as_u64),
            cache_write_input_tokens: None,
            reasoning_tokens: usage
                .pointer("/completion_tokens_details/reasoning_tokens")
                .and_then(Value::as_u64),
        });
    }
    Ok(chunk)
}

fn normalize_openai_responses_event(
    event: Option<&str>,
    value: &Value,
) -> Result<NormalizedChunk, ProviderFailure> {
    let event_type = event
        .or_else(|| value.get("type").and_then(Value::as_str))
        .unwrap_or_default();
    if event_type == "error" || event_type == "response.failed" {
        return Ok(NormalizedChunk {
            remote_error: Some(json_remote_error(
                value
                    .get("error")
                    .or_else(|| value.pointer("/response/error"))
                    .unwrap_or(value),
            )),
            ..Default::default()
        });
    }

    let mut chunk = NormalizedChunk::default();
    match event_type {
        "response.output_text.delta" => {
            if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                if !delta.is_empty() {
                    chunk.text.push(delta.to_owned());
                }
            }
        }
        "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
            if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                if !delta.is_empty() {
                    chunk.reasoning.push(delta.to_owned());
                }
            }
        }
        "response.completed" | "response.incomplete" => {
            let response = value.get("response").unwrap_or(value);
            chunk.terminal_marker = Some(ProviderTerminalMarker::OpenAiResponsesTerminal);
            chunk.finish_reason = if event_type == "response.incomplete" {
                response
                    .pointer("/incomplete_details/reason")
                    .and_then(Value::as_str)
                    .or(Some("incomplete"))
                    .map(str::to_owned)
            } else {
                Some("stop".to_owned())
            };
            if let Some(usage) = response.get("usage") {
                chunk.usage = Some(normalize_openai_responses_usage(usage));
            }
        }
        _ => {
            if let Some(error) = value.get("error") {
                chunk.remote_error = Some(json_remote_error(error));
            }
        }
    }
    Ok(chunk)
}

fn normalize_openai_responses_usage(value: &Value) -> NormalizedUsage {
    let cached_input_tokens = value
        .pointer("/input_tokens_details/cached_tokens")
        .and_then(Value::as_u64);
    NormalizedUsage {
        input_tokens: u64_field(value, &["input_tokens"]),
        output_tokens: u64_field(value, &["output_tokens"]),
        cached_input_tokens,
        cache_read_input_tokens: cached_input_tokens,
        cache_write_input_tokens: u64_field(value, &["cache_write_tokens"]),
        reasoning_tokens: value
            .pointer("/output_tokens_details/reasoning_tokens")
            .and_then(Value::as_u64),
    }
}

fn normalize_anthropic_event(
    event: Option<&str>,
    value: &Value,
) -> Result<NormalizedChunk, ProviderFailure> {
    let event_type = event
        .or_else(|| value.get("type").and_then(Value::as_str))
        .unwrap_or_default();
    if event_type == "error" {
        return Ok(NormalizedChunk {
            remote_error: Some(json_remote_error(value.get("error").unwrap_or(value))),
            ..Default::default()
        });
    }
    let mut chunk = NormalizedChunk::default();
    if event_type == "content_block_delta" {
        let delta_type = value
            .pointer("/delta/type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if let Some(text) = value.pointer("/delta/text").and_then(Value::as_str) {
            if delta_type == "thinking_delta" {
                chunk.reasoning.push(text.to_owned());
            } else {
                chunk.text.push(text.to_owned());
            }
        }
        if let Some(thinking) = value.pointer("/delta/thinking").and_then(Value::as_str) {
            chunk.reasoning.push(thinking.to_owned());
        }
    }
    if event_type == "message_delta" {
        chunk.finish_reason = value
            .pointer("/delta/stop_reason")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(usage) = value.get("usage") {
            let cache_read_input_tokens = u64_field(usage, &["cache_read_input_tokens"]);
            let cache_write_input_tokens = anthropic_cache_creation_input_tokens(usage);
            chunk.usage = Some(NormalizedUsage {
                input_tokens: u64_field(usage, &["input_tokens"]),
                output_tokens: u64_field(usage, &["output_tokens"]),
                cached_input_tokens: add_optional_u64(
                    cache_read_input_tokens,
                    cache_write_input_tokens,
                ),
                cache_read_input_tokens,
                cache_write_input_tokens,
                reasoning_tokens: None,
            });
        }
    }
    if event_type == "message_stop" {
        chunk.terminal_marker = Some(ProviderTerminalMarker::AnthropicMessageStop);
        chunk.finish_reason = value
            .pointer("/delta/stop_reason")
            .or_else(|| value.get("stop_reason"))
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    if event_type == "message_start" {
        if let Some(usage) = value.pointer("/message/usage") {
            let cache_read_input_tokens = u64_field(usage, &["cache_read_input_tokens"]);
            let cache_write_input_tokens = anthropic_cache_creation_input_tokens(usage);
            chunk.usage = Some(NormalizedUsage {
                input_tokens: u64_field(usage, &["input_tokens"]),
                output_tokens: u64_field(usage, &["output_tokens"]),
                cached_input_tokens: add_optional_u64(
                    cache_read_input_tokens,
                    cache_write_input_tokens,
                ),
                cache_read_input_tokens,
                cache_write_input_tokens,
                reasoning_tokens: None,
            });
        }
    }
    Ok(chunk)
}

fn normalize_gemini_event(value: &Value) -> Result<NormalizedChunk, ProviderFailure> {
    if let Some(error) = value.get("error") {
        return Ok(NormalizedChunk {
            remote_error: Some(json_remote_error(error)),
            ..Default::default()
        });
    }
    let mut chunk = NormalizedChunk::default();
    for candidate in value
        .get("candidates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for part in candidate
            .pointer("/content/parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                if part
                    .get("thought")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    chunk.reasoning.push(text.to_owned());
                } else {
                    chunk.text.push(text.to_owned());
                }
            }
        }
        if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str) {
            chunk.finish_reason = Some(reason.to_owned());
            chunk.terminal_marker = Some(ProviderTerminalMarker::GeminiFinishReason);
        }
    }
    if let Some(usage) = value.get("usageMetadata") {
        chunk.usage = Some(NormalizedUsage {
            input_tokens: u64_field(usage, &["promptTokenCount"]),
            output_tokens: u64_field(usage, &["candidatesTokenCount"]),
            cached_input_tokens: u64_field(usage, &["cachedContentTokenCount"]),
            cache_read_input_tokens: u64_field(usage, &["cachedContentTokenCount"]),
            cache_write_input_tokens: None,
            reasoning_tokens: u64_field(usage, &["thoughtsTokenCount"]),
        });
    }
    Ok(chunk)
}

fn parse_model_list(
    family: ProviderFamily,
    value: &Value,
) -> Result<Vec<ProviderModel>, ProviderFailure> {
    let rows = match family {
        ProviderFamily::OpenAi | ProviderFamily::OpenAiResponses => value.get("data"),
        ProviderFamily::Anthropic => value.get("data"),
        ProviderFamily::Gemini => value.get("models"),
    }
    .and_then(Value::as_array)
    .ok_or_else(|| {
        ProviderFailure::new(
            "provider_protocol_error",
            "The provider returned an invalid model catalog",
        )
    })?;
    if rows.len() > MAX_MODELS {
        return Err(ProviderFailure::new(
            "provider_catalog_too_large",
            "The provider returned too many models",
        ));
    }
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for row in rows {
        let raw_id = row
            .get("id")
            .or_else(|| row.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let id = raw_id.strip_prefix("models/").unwrap_or(raw_id).trim();
        if id.is_empty()
            || id.len() > MAX_MODEL_ID_BYTES
            || id.chars().any(char::is_control)
            || !seen.insert(id.to_owned())
        {
            continue;
        }
        let display_name = row.get("display_name").or_else(|| row.get("displayName"));
        let display_name = bounded_catalog_text(display_name).unwrap_or_else(|| id.to_owned());
        let methods = row
            .get("supportedGenerationMethods")
            .and_then(Value::as_array);
        if family == ProviderFamily::Gemini
            && methods.is_some_and(|values| {
                !values.iter().any(|value| {
                    value.as_str().is_some_and(|method| {
                        method == "generateContent" || method == "streamGenerateContent"
                    })
                })
            })
        {
            continue;
        }
        result.push(ProviderModel {
            id: id.to_owned(),
            display_name,
            owned_by: bounded_catalog_text(row.get("owned_by")),
            created_at: row.get("created").and_then(Value::as_i64),
            capabilities: catalog_capabilities(row),
        });
    }
    result.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
    });
    Ok(result)
}

/// Provider model catalogs are untrusted renderer-facing input. Keep labels
/// bounded and single-line so a provider cannot inject control characters or
/// an oversized value into model pickers, diagnostics, exports, or telemetry
/// projections. Invalid optional labels remain unknown; display names fall
/// back to the already-validated model identifier at the call site.
fn bounded_catalog_text(value: Option<&Value>) -> Option<String> {
    let value = value.and_then(Value::as_str)?.trim();
    if value.is_empty() || value.len() > MAX_MODEL_ID_BYTES || value.chars().any(char::is_control) {
        return None;
    }
    Some(value.to_owned())
}

fn native_destination_error(error: DestinationError) -> NativeError {
    omnia_provider_services::routing::native_destination_error(error)
}

async fn validated_client_for_profile(
    _gateway: &ProviderGateway,
    profile: &ProviderProfileRecord,
) -> NativeResult<Client> {
    destination::validated_client(
        &profile.normalized_base_url,
        profile.enabled,
        profile.local_network_grant,
    )
    .await
    .map_err(native_destination_error)
}

#[cfg(test)]
fn validate_resolved_addresses(
    scheme: &str,
    addresses: impl IntoIterator<Item = SocketAddr>,
    local_network_grant: bool,
) -> NativeResult<Vec<SocketAddr>> {
    destination::validate_resolved_addresses(scheme, addresses, local_network_grant)
        .map_err(native_destination_error)
}

fn load_credential(
    state: &AppState,
    profile: &ProviderProfileRecord,
) -> NativeResult<Option<Zeroizing<String>>> {
    let credential_ref = state.storage.provider_credential_ref(&profile.id)?;
    credential_from_reference(state, &profile.auth_scheme, credential_ref.as_deref())
}

// The caller owns profile/ref snapshot authority. This helper never re-reads storage.
fn credential_from_reference(
    state: &AppState,
    auth_scheme: &str,
    credential_ref: Option<&str>,
) -> NativeResult<Option<Zeroizing<String>>> {
    match credential_ref {
        Some(secret_ref) => {
            state
                .secrets
                .with_secret(SecretPurpose::ProviderCredential, secret_ref, |secret| {
                    Ok(Some(Zeroizing::new(secret.to_owned())))
                })
        }
        None if normalize_identifier(auth_scheme) == "none" => Ok(None),
        None => Err(NativeError::new(
            "secret_missing",
            "The provider credential is missing",
        )),
    }
}

/// Resolves a credential from an already-proven immutable provider
/// definition.  Prepared dispatch must use this path so the opaque secret
/// handle cannot be re-read from a mutable provider profile between proof
/// acquisition and the final dispatch transition.
fn load_credential_for_definition(
    state: &AppState,
    definition: &FrozenProviderDefinition,
) -> NativeResult<Option<Zeroizing<String>>> {
    definition.validate()?;
    match definition.credential_ref.as_deref() {
        Some(secret_ref) => {
            state
                .secrets
                .with_secret(SecretPurpose::ProviderCredential, secret_ref, |secret| {
                    Ok(Some(Zeroizing::new(secret.to_owned())))
                })
        }
        None if normalize_identifier(&definition.auth_scheme) == "none" => Ok(None),
        None => Err(NativeError::new(
            "secret_missing",
            "The provider credential is missing",
        )),
    }
}

fn provider_family(provider_type: &str) -> Result<ProviderFamily, ProviderFailure> {
    match normalize_identifier(provider_type).as_str() {
        "openai" => Ok(ProviderFamily::OpenAiResponses),
        "deepseek" | "openai_compatible" | "local" => Ok(ProviderFamily::OpenAi),
        "anthropic" => Ok(ProviderFamily::Anthropic),
        "gemini" | "google" | "google_gemini" => Ok(ProviderFamily::Gemini),
        "azure" | "azure_openai" => Err(ProviderFailure::new(
            "provider_not_available",
            "Azure OpenAI deployment and API-version routing are not available in this preview",
        )),
        "custom" | "custom_adapter" => Err(ProviderFailure::new(
            "provider_not_available",
            "Declarative custom adapters are not available in this preview",
        )),
        _ => Err(ProviderFailure::new(
            "unsupported_provider",
            "This provider type has no installed native adapter",
        )),
    }
}

fn parse_base_url(profile: &ProviderProfileRecord) -> Result<Url, ProviderFailure> {
    Url::parse(&profile.normalized_base_url).map_err(|_| {
        ProviderFailure::new(
            "invalid_provider_profile",
            "The provider base URL is invalid",
        )
    })
}

fn join_endpoint(base: &Url, endpoint: &str) -> Result<Url, ProviderFailure> {
    let mut normalized = base.clone();
    if !normalized.path().ends_with('/') {
        normalized.set_path(&format!("{}/", normalized.path()));
    }
    normalized.join(endpoint).map_err(|_| {
        ProviderFailure::new(
            "invalid_provider_profile",
            "The provider endpoint could not be constructed",
        )
    })
}

fn gemini_model_path(model: &str) -> Result<String, ProviderFailure> {
    let model = model.strip_prefix("models/").unwrap_or(model).trim();
    if model.is_empty()
        || model.len() > MAX_MODEL_ID_BYTES
        || model.contains('/')
        || model.contains('?')
        || model.contains('#')
        || model.chars().any(char::is_control)
    {
        return Err(ProviderFailure::new(
            "invalid_model",
            "The Gemini model identifier is invalid",
        ));
    }
    Ok(model.to_owned())
}

fn normalize_identifier(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace(['-', ' '], "_")
}

fn insert_number(
    body: &mut Map<String, Value>,
    key: &str,
    value: Option<f64>,
) -> Result<(), ProviderFailure> {
    if let Some(value) = value {
        if !value.is_finite() {
            return Err(ProviderFailure::new(
                "invalid_parameter",
                format!("{key} must be finite"),
            ));
        }
        body.insert(key.to_owned(), json!(value));
    }
    Ok(())
}

fn insert_u64(body: &mut Map<String, Value>, key: &str, value: Option<u64>) {
    if let Some(value) = value {
        body.insert(key.to_owned(), json!(value));
    }
}

fn validated_stop(stop: &Option<Vec<String>>) -> Result<Option<Vec<String>>, ProviderFailure> {
    let Some(stop) = stop else {
        return Ok(None);
    };
    if stop.len() > 16
        || stop
            .iter()
            .any(|value| value.is_empty() || value.len() > 4_096)
    {
        return Err(ProviderFailure::new(
            "invalid_parameter",
            "stop must contain at most 16 bounded nonempty strings",
        ));
    }
    Ok(Some(stop.clone()))
}

fn validate_reasoning_effort(value: &str) -> Result<String, ProviderFailure> {
    let normalized = normalize_identifier(value);
    if matches!(
        normalized.as_str(),
        "none" | "minimal" | "low" | "medium" | "high" | "max"
    ) {
        Ok(normalized)
    } else {
        Err(ProviderFailure::new(
            "invalid_parameter",
            "reasoningEffort is invalid",
        ))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AnthropicThinkingMode {
    Legacy,
    Adaptive,
}

/// Claude Code's current Messages path uses adaptive thinking for the newer
/// 4.6+ model families and the legacy budget form for earlier families. Keep
/// the model-family decision in the adapter instead of sending one shape to
/// every model and waiting for a provider 400.
fn anthropic_thinking_mode(model: &str) -> AnthropicThinkingMode {
    let mut name = model.trim().to_ascii_lowercase();
    for prefix in ["us.anthropic.", "eu.anthropic.", "anthropic."] {
        if let Some(stripped) = name.strip_prefix(prefix) {
            name = stripped.to_owned();
            break;
        }
    }
    let adaptive = [
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-sonnet-4-6",
    ];
    let legacy = [
        "claude-3-",
        "claude-opus-4-0",
        "claude-opus-4-1",
        "claude-opus-4-5",
        "claude-sonnet-4-0",
        "claude-sonnet-4-5",
        "claude-haiku-4-5",
    ];
    if adaptive
        .iter()
        .any(|family| name.starts_with(family) || name.contains(family))
    {
        AnthropicThinkingMode::Adaptive
    } else if legacy
        .iter()
        .any(|family| name.starts_with(family) || name.contains(family))
    {
        AnthropicThinkingMode::Legacy
    } else {
        // Unknown/future Claude model IDs should follow the current Claude
        // Code default; a provider capability probe can still reject it
        // before a durable run is marked complete.
        AnthropicThinkingMode::Adaptive
    }
}

fn anthropic_adaptive_effort(value: &str) -> &'static str {
    match value {
        "minimal" | "low" => "low",
        "medium" => "medium",
        "high" => "high",
        "max" => "max",
        _ => "medium",
    }
}

fn reasoning_budget(value: &str) -> u64 {
    match value {
        "none" => 0,
        // Anthropic rejects legacy extended-thinking budgets below 1,024
        // tokens. Keep the lowest user-facing effort inside that contract.
        "minimal" => 1_024,
        "low" => 1_024,
        "high" => 16_384,
        "max" => 32_768,
        _ => 4_096,
    }
}

fn merge_native(
    body: &mut Map<String, Value>,
    native: &Option<Map<String, Value>>,
    reserved: &[&str],
) -> Result<(), ProviderFailure> {
    let Some(native) = native else {
        return Ok(());
    };
    if native.len() > 64 {
        return Err(ProviderFailure::new(
            "invalid_parameter",
            "native contains too many fields",
        ));
    }
    for (key, value) in native {
        if key.is_empty() || key.len() > 128 || key.chars().any(char::is_control) {
            return Err(ProviderFailure::new(
                "invalid_parameter",
                "native contains an invalid key",
            ));
        }
        if reserved
            .iter()
            .any(|reserved| key.eq_ignore_ascii_case(reserved))
        {
            return Err(ProviderFailure::new(
                "invalid_parameter",
                format!("native.{key} cannot override a canonical or security-controlled field"),
            ));
        }
        body.insert(key.clone(), value.clone());
    }
    Ok(())
}

fn openai_reserved_keys() -> &'static [&'static str] {
    &[
        "model",
        "messages",
        "stream",
        "stream_options",
        "temperature",
        "top_p",
        "max_tokens",
        "seed",
        "stop",
        "reasoning_effort",
        "response_format",
    ]
}

fn openai_responses_reserved_keys() -> &'static [&'static str] {
    &[
        "model",
        "stream",
        "store",
        "input",
        "temperature",
        "top_p",
        "max_output_tokens",
        "reasoning",
        "text",
    ]
}

fn anthropic_reserved_keys() -> &'static [&'static str] {
    &[
        "model",
        "messages",
        "system",
        "stream",
        "max_tokens",
        "temperature",
        "top_p",
        "top_k",
        "stop_sequences",
        "thinking",
        "output_config",
    ]
}

fn gemini_reserved_keys() -> &'static [&'static str] {
    &["model", "contents", "systemInstruction", "generationConfig"]
}

fn unsupported_parameter(parameter: &str, provider: &str) -> ProviderFailure {
    ProviderFailure::new(
        "unsupported_parameter",
        format!("{parameter} is explicitly set but unsupported by {provider}"),
    )
}

fn classify_reqwest_error(error: reqwest::Error) -> ProviderFailure {
    if error.is_timeout() {
        ProviderFailure::retryable("provider_timeout", "The provider request timed out")
            .with_error_class(ProviderErrorClass::Timeout)
    } else if error.is_connect() {
        ProviderFailure::retryable(
            "provider_connection_failed",
            "The provider could not be reached",
        )
        .with_error_class(ProviderErrorClass::Transport)
    } else if error.is_body() || error.is_decode() {
        ProviderFailure::retryable(
            "provider_stream_interrupted",
            "The provider stream was interrupted",
        )
        .with_error_class(ProviderErrorClass::Transport)
    } else {
        ProviderFailure::retryable("provider_transport_failed", "The provider transport failed")
            .with_error_class(ProviderErrorClass::Transport)
    }
}

fn default_provider_error_class(code: &'static str) -> ProviderErrorClass {
    match code {
        "provider_dns_failed" | "provider_dns_mixed_scope" => ProviderErrorClass::Dns,
        "provider_timeout" => ProviderErrorClass::Timeout,
        "provider_connection_failed" | "provider_transport_failed" => ProviderErrorClass::Transport,
        "provider_stream_interrupted" => ProviderErrorClass::Transport,
        "provider_protocol_error"
        | "provider_redirect_blocked"
        | "provider_frame_too_large"
        | "provider_response_too_large"
        | "provider_catalog_too_large" => ProviderErrorClass::Protocol,
        "unsupported_parameter" | "invalid_parameter" | "invalid_model" => {
            ProviderErrorClass::Schema
        }
        "cancelled" => ProviderErrorClass::Cancelled,
        _ => ProviderErrorClass::Unknown,
    }
}

/// Normalizes the HTTP `Retry-After` header to milliseconds without allowing
/// an untrusted provider to create an unbounded wait. RFC 9110 permits either
/// delta-seconds or an HTTP-date (RFC 2822-compatible IMF-fixdate). Values in
/// the past are immediately eligible (`0`); values beyond the native retry
/// horizon are clamped to the horizon and never represented as an overflow.
fn parse_retry_after_ms(value: &str) -> Option<u64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds.saturating_mul(1_000).min(MAX_RETRY_AFTER_MS));
    }

    let date = DateTime::parse_from_rfc2822(value)
        .ok()?
        .with_timezone(&Utc);
    let delta_ms = date.signed_duration_since(Utc::now()).num_milliseconds();
    Some(
        u64::try_from(delta_ms.max(0))
            .unwrap_or(MAX_RETRY_AFTER_MS)
            .min(MAX_RETRY_AFTER_MS),
    )
}

fn native_provider_error(error: ProviderFailure) -> NativeError {
    let ProviderFailure {
        code,
        message,
        retryable,
        error_class,
        status,
        retry_after_ms,
        acceptance,
    } = error;
    let acceptance = match acceptance {
        ProviderAcceptanceEvidence::NotAccepted => Some("false"),
        ProviderAcceptanceEvidence::Accepted => Some("true"),
        ProviderAcceptanceEvidence::Unknown => Some("unknown"),
    };
    let native = if retryable {
        NativeError::retryable(code, message)
    } else {
        NativeError::new(code, message)
    };
    native
        .with_provider_metadata(status, retry_after_ms, acceptance)
        .with_provider_error_class(error_class)
}

fn native_input_failure(error: NativeError) -> ProviderFailure {
    let error_class = error.error_class;
    let failure = if error.retryable {
        ProviderFailure::retryable(error.code, error.message)
    } else {
        ProviderFailure::new(error.code, error.message)
    };
    match error_class {
        Some(error_class) => failure.with_error_class(error_class),
        None => failure,
    }
}

fn native_storage_failure(error: NativeError) -> ProviderFailure {
    let error_class = error.error_class;
    let failure = if error.retryable {
        ProviderFailure::retryable(error.code, error.message)
    } else {
        ProviderFailure::new(error.code, error.message)
    };
    match error_class {
        Some(error_class) => failure.with_error_class(error_class),
        None => failure,
    }
}

fn provider_request_id(headers: &header::HeaderMap) -> Option<String> {
    ["x-request-id", "request-id", "x-goog-request-id"]
        .iter()
        .find_map(|name| headers.get(*name))
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
                })
        })
        .filter(|value| !looks_like_secret(value))
        .map(str::to_owned)
}

fn looks_like_secret(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("sk-")
        || lower.starts_with("rk-")
        || lower.starts_with("pk-")
        || lower.starts_with("sess-")
        || lower.starts_with("sess_")
        || lower.starts_with("bearer")
        || lower.starts_with("basic ")
        || lower.starts_with("eyj")
        || lower.starts_with("aiza")
        || lower.contains("api_key")
        || lower.contains("api-key")
        || lower.contains("apikey")
        || lower.contains("access_token")
        || lower.contains("client_secret")
        || lower.contains("credential")
        || lower.contains("authorization")
        || lower.contains("proxy-authorization")
        || lower.contains("password")
        || lower.contains("cookie")
        || lower.contains("session")
        || lower.contains("token=")
        || lower.contains("secret=")
        || looks_like_jwt(value)
        || looks_like_opaque_token(value)
}

fn looks_like_jwt(value: &str) -> bool {
    let mut segments = value.split('.');
    let Some(first) = segments.next() else {
        return false;
    };
    let Some(second) = segments.next() else {
        return false;
    };
    let Some(third) = segments.next() else {
        return false;
    };
    if segments.next().is_some() || first.len() < 8 || second.len() < 8 || third.len() < 8 {
        return false;
    }
    [first, second, third].iter().all(|segment| {
        segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    })
}

fn looks_like_opaque_token(value: &str) -> bool {
    let value = value.trim();
    if value.len() < 32 || value.chars().any(char::is_whitespace) {
        return false;
    }
    let mut has_lower = false;
    let mut has_upper = false;
    let mut has_digit = false;
    for byte in value.bytes() {
        match byte {
            b'a'..=b'z' => has_lower = true,
            b'A'..=b'Z' => has_upper = true,
            b'0'..=b'9' => has_digit = true,
            b'_' | b'-' => {}
            _ => return false,
        }
    }
    has_lower && has_upper && has_digit
}

fn looks_like_sensitive_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    // Provider error bodies are untrusted and may echo the user's prompt or
    // private context. Treat those labels as sensitive even when the echoed
    // text does not contain a recognizable token, path, or URL.
    lower.contains("user prompt")
        || lower.contains("system prompt")
        || lower.contains("conversation history")
        || lower.contains("private context")
        || lower.contains("model input")
        || lower.contains("://")
        || lower.starts_with("file:")
        || lower.contains("\\\\")
        || lower.contains("/home/")
        || lower.contains("/users/")
        || lower.contains("/var/")
        || lower.contains("\\users\\")
        || lower.contains("\\windows\\")
        || value.split_whitespace().any(looks_like_secret)
        || looks_like_secret(value)
}

fn safe_provider_error_message(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let candidate = value
        .pointer("/error/message")
        .or_else(|| value.pointer("/error/status"))
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)?;
    let redacted = redact_sensitive_text(candidate);
    (!redacted.is_empty()).then_some(redacted)
}

fn redact_sensitive_text(value: &str) -> String {
    let compact: String = value
        .chars()
        .filter(|character| !character.is_control() || *character == ' ')
        .take(600)
        .collect();
    if looks_like_sensitive_text(&compact) {
        "Provider returned a redacted authentication error".to_owned()
    } else {
        compact
    }
}

fn json_remote_error(value: &Value) -> ProviderFailure {
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .map(redact_sensitive_text)
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| "The provider reported a streaming error".to_owned());
    ProviderFailure::new("provider_stream_error", message)
}

fn u64_field(value: &Value, fields: &[&str]) -> Option<u64> {
    fields
        .iter()
        .find_map(|field| value.get(*field).and_then(Value::as_u64))
}

fn sum_u64_fields(value: &Value, fields: &[&str]) -> Option<u64> {
    let mut total: Option<u64> = None;
    for value in fields
        .iter()
        .filter_map(|field| value.get(*field).and_then(Value::as_u64))
    {
        total = Some(match total {
            Some(total) => total.checked_add(value)?,
            None => value,
        });
    }
    total
}

/// Anthropic has emitted cache-write usage in two wire shapes over time:
/// the top-level `cache_creation_input_tokens` counter and the newer nested
/// `cache_creation` breakdown (`ephemeral_5m_input_tokens` /
/// `ephemeral_1h_input_tokens`).  Prefer the provider's aggregate when it is
/// non-zero; when it is absent or zero, recover the nested breakdown so a
/// valid cache write is not reported as zero.
fn anthropic_cache_creation_input_tokens(value: &Value) -> Option<u64> {
    let direct = u64_field(value, &["cache_creation_input_tokens"]);
    let nested = value.get("cache_creation").and_then(|cache_creation| {
        sum_u64_fields(
            cache_creation,
            &["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"],
        )
    });
    match (direct, nested) {
        (Some(direct), Some(nested)) if direct == 0 && nested > 0 => Some(nested),
        (Some(direct), _) => Some(direct),
        (None, nested) => nested,
    }
}

fn add_optional_u64(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => left.checked_add(right),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn normalize_finish_reason(value: &str) -> String {
    match normalize_identifier(value).as_str() {
        "cancelled" => "cancelled",
        "length" | "max_tokens" | "max_tokens_reached" => "length",
        "content_filter" | "safety" | "recitation" | "blocked" => "content_filter",
        "tool_use" | "tool_calls" | "function_call" => "tool_calls",
        _ => "stop",
    }
    .to_owned()
}

fn catalog_capabilities(row: &Value) -> ProviderModelCapabilities {
    // A model name or provider brand is not capability evidence. This matters
    // especially for local and OpenAI-compatible endpoints, which share the
    // OpenAI wire adapter but may expose arbitrary models. Only preserve
    // model-specific claims that the live catalog explicitly declares.
    let tools = declared_catalog_capability(row, "tools");
    let vision = declared_catalog_capability(row, "vision");
    let reasoning = declared_catalog_capability(row, "reasoning");
    let source = if tools.is_some() || vision.is_some() || reasoning.is_some() {
        "provider_live"
    } else {
        "unknown"
    };

    ProviderModelCapabilities {
        // The installed adapters use a streaming request path for every model
        // they expose. This describes adapter behavior, not a guessed model
        // modality or tool/reasoning feature.
        streaming: true,
        tools,
        vision,
        reasoning,
        source,
    }
}

fn declared_catalog_capability(row: &Value, capability: &str) -> Option<bool> {
    match row.get("capabilities") {
        Some(Value::Object(capabilities)) => capabilities.get(capability).and_then(Value::as_bool),
        Some(Value::Array(capabilities)) => capabilities
            .iter()
            .filter_map(Value::as_str)
            .any(|declared| normalize_identifier(declared) == capability)
            .then_some(true),
        _ => None,
    }
}

#[derive(Default, Debug)]
struct SseDecoder {
    buffer: Vec<u8>,
}

#[derive(Debug, PartialEq)]
struct SseFrame {
    event: Option<String>,
    data: String,
}

impl SseDecoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseFrame>, ProviderFailure> {
        // Do not append a network chunk before checking its size.  A single
        // oversized chunk must fail immediately even when it contains several
        // otherwise-valid frames, otherwise the temporary allocation can
        // exceed the decoder's frame bound.
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(ProviderFailure::new(
                "provider_frame_too_large",
                "The provider sent an oversized streaming frame",
            ));
        }
        let new_len = self.buffer.len().checked_add(bytes.len()).ok_or_else(|| {
            ProviderFailure::new(
                "provider_frame_too_large",
                "The provider sent an oversized streaming frame",
            )
        })?;
        if new_len > MAX_FRAME_BYTES {
            return Err(ProviderFailure::new(
                "provider_frame_too_large",
                "The provider sent an oversized streaming frame",
            ));
        }
        self.buffer.try_reserve_exact(bytes.len()).map_err(|_| {
            ProviderFailure::new(
                "provider_frame_too_large",
                "The provider sent an oversized streaming frame",
            )
        })?;
        self.buffer.extend_from_slice(bytes);
        let mut frames = Vec::new();
        while let Some((index, delimiter_len)) = find_frame_boundary(&self.buffer) {
            let raw = self.buffer.drain(..index).collect::<Vec<_>>();
            self.buffer.drain(..delimiter_len);
            if let Some(frame) = parse_sse_frame(&raw)? {
                frames.push(frame);
            }
        }
        Ok(frames)
    }

    fn finish(&mut self) -> Result<(), ProviderFailure> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        self.buffer.clear();
        Err(ProviderFailure::retryable(
            "provider_stream_interrupted",
            "The provider stream ended in the middle of an SSE frame",
        ))
    }
}

fn find_frame_boundary(bytes: &[u8]) -> Option<(usize, usize)> {
    let crlf = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4));
    let lf = bytes
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| (index, 2));
    match (crlf, lf) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn parse_sse_frame(raw: &[u8]) -> Result<Option<SseFrame>, ProviderFailure> {
    let text = std::str::from_utf8(raw).map_err(|_| {
        ProviderFailure::new(
            "provider_protocol_error",
            "The provider stream was not valid UTF-8",
        )
    })?;
    let mut event = None;
    let mut data = Vec::new();
    for line in text.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.starts_with(':') || line.is_empty() {
            continue;
        }
        let (field, value) = line
            .split_once(':')
            .map(|(field, value)| (field, value.strip_prefix(' ').unwrap_or(value)))
            .unwrap_or((line, ""));
        match field {
            "event" => event = Some(value.to_owned()),
            "data" => data.push(value),
            _ => {}
        }
    }
    if data.is_empty() {
        Ok(None)
    } else {
        Ok(Some(SseFrame {
            event,
            data: data.join("\n"),
        }))
    }
}

/// Builds an agent-harness provider from a saved profile, reusing the same
/// destination checks (DNS scope, local-network grant, HTTPS for internet
/// hosts) and keyring credential as the legacy gateway.
pub(crate) async fn harness_provider(
    state: &AppState,
    profile_id: &str,
    request_log: Option<std::sync::Arc<omnia_harness::provider::record::RequestLog>>,
) -> NativeResult<std::sync::Arc<dyn omnia_harness::Provider>> {
    let snapshot = state
        .storage
        .provider_credential_snapshot(profile_id.trim())?;
    let credential = credential_from_reference(
        state,
        &snapshot.profile.auth_scheme,
        snapshot.credential_ref.as_deref(),
    )?;
    build_harness_provider(&snapshot.profile, credential, request_log).await
}

/// Builds a harness provider from the immutable provider definition captured
/// for a prepared attempt.  The live profile is used only for safe display and
/// credential-status metadata; destination, adapter, auth, routing and egress
/// fields are reconstructed from the frozen definition so a queued compare
/// cannot drift when the profile is edited between preparation and dispatch.
pub(crate) async fn harness_provider_for_definition(
    state: &AppState,
    live_profile: &ProviderProfileRecord,
    definition: &crate::provider_definition::FrozenProviderDefinition,
    request_log: Option<std::sync::Arc<omnia_harness::provider::record::RequestLog>>,
) -> NativeResult<std::sync::Arc<dyn omnia_harness::Provider>> {
    definition.validate()?;
    let profile = dispatch_profile_for_definition(live_profile, definition);
    let credential = load_credential_for_definition(state, definition)?;
    build_harness_provider(&profile, credential, request_log).await
}

async fn build_harness_provider(
    profile: &ProviderProfileRecord,
    credential: Option<Zeroizing<String>>,
    request_log: Option<std::sync::Arc<omnia_harness::provider::record::RequestLog>>,
) -> NativeResult<std::sync::Arc<dyn omnia_harness::Provider>> {
    use omnia_provider_services::routing::{build_provider, ProviderProfileInput};
    build_provider(
        ProviderProfileInput {
            provider_type: &profile.provider_type,
            base_url: &profile.normalized_base_url,
            auth_scheme: &profile.auth_scheme,
            organization: profile.organization_id.as_deref(),
            project: profile.remote_project_id.as_deref(),
            enabled: profile.enabled,
            local_network_grant: profile.local_network_grant,
        },
        credential.as_deref().map(|secret| secret.to_string()),
        request_log,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_cache_plan::{ProviderCacheMode, ProviderCacheUnsupportedBehavior};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn shared_destination_errors_preserve_native_policy_metadata() {
        for (class, expected_class) in [
            (DestinationErrorClass::Dns, Some(ProviderErrorClass::Dns)),
            (
                DestinationErrorClass::Transport,
                Some(ProviderErrorClass::Transport),
            ),
            (DestinationErrorClass::Policy, None),
            (DestinationErrorClass::InvalidInput, None),
        ] {
            for retryable in [false, true] {
                let error = native_destination_error(DestinationError {
                    code: "fixture_destination_error",
                    message: "Static fixture diagnostic",
                    retryable,
                    class,
                });
                assert_eq!(error.code, "fixture_destination_error");
                assert_eq!(error.message, "Static fixture diagnostic");
                assert_eq!(error.retryable, retryable);
                assert_eq!(error.error_class, expected_class);
                assert_eq!(
                    error.source,
                    if expected_class.is_some() {
                        "provider"
                    } else {
                        "native"
                    }
                );
                assert!(error.acceptance.is_none());
                assert!(error.status.is_none());
            }
        }
    }

    fn test_profile(provider_type: &str, auth_scheme: &str) -> ProviderProfileRecord {
        ProviderProfileRecord {
            id: "provider_0123456789abcdef0123456789abcdef".into(),
            provider_type: provider_type.into(),
            display_name: "Test provider".into(),
            normalized_base_url: "https://provider.invalid/v1".into(),
            auth_scheme: auth_scheme.into(),
            organization_id: None,
            remote_project_id: None,
            credential_status: crate::storage::CredentialStatus::Present,
            local_network_grant: false,
            enabled: true,
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[tokio::test]
    async fn shared_factory_host_rejects_disabled_before_unsupported_routing() {
        let mut profile = test_profile("unsupported", "unsupported");
        profile.enabled = false;
        profile.normalized_base_url = "invalid URL".into();
        let error = build_harness_provider(&profile, None, None)
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "provider_disabled");
        assert!(!error.retryable);
    }

    #[tokio::test]
    async fn shared_factory_host_maps_credential_and_header_failures_without_dns() {
        let mut profile = test_profile("openai", "bearer");
        let error = build_harness_provider(&profile, None, None)
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "secret_missing");
        profile.organization_id = Some("invalid\norganization".into());
        let error = build_harness_provider(
            &profile,
            Some(Zeroizing::new("synthetic-host-test-key".into())),
            None,
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.code, "invalid_provider_header");
        assert!(!error.message.contains("synthetic-host-test-key"));
        assert!(!error.message.contains("organization"));
    }

    async fn spawn_http_response(response: Vec<u8>) -> SocketAddr {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 8 * 1024];
            let _ = socket.read(&mut request).await.unwrap();
            socket.write_all(&response).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        address
    }

    async fn request_local_response(response: Vec<u8>) -> Response {
        let address = spawn_http_response(response).await;
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
            .get(format!("http://{address}/test"))
            .send()
            .await
            .unwrap()
    }

    #[test]
    fn fragmented_sse_is_reassembled_without_duplication() {
        let mut decoder = SseDecoder::default();
        assert!(decoder
            .push(b"event: content_block_delta\ndata: {\"del")
            .unwrap()
            .is_empty());
        let events = decoder
            .push(b"ta\":{\"text\":\"hi\"}}\n\ndata: [DONE]\n\n")
            .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event.as_deref(), Some("content_block_delta"));
        assert_eq!(events[0].data, "{\"delta\":{\"text\":\"hi\"}}");
        assert_eq!(events[1].data, "[DONE]");
    }

    #[test]
    fn provider_streams_normalize_text_usage_and_finish_reasons() {
        let openai = normalize_openai_event(&json!({
            "choices":[{"delta":{"content":"Hello"},"finish_reason":"length"}],
            "usage":{"prompt_tokens":12,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":4}}
        })).unwrap();
        assert_eq!(openai.text, vec!["Hello"]);
        assert_eq!(openai.finish_reason.as_deref(), Some("length"));
        let openai_usage = openai.usage.unwrap();
        assert_eq!(openai_usage.cached_input_tokens, Some(4));
        assert_eq!(openai_usage.cache_read_input_tokens, Some(4));
        assert_eq!(openai_usage.cache_write_input_tokens, None);

        let gemini = normalize_gemini_event(&json!({
            "candidates":[{"content":{"parts":[{"text":"World"}]},"finishReason":"STOP"}],
            "usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}
        }))
        .unwrap();
        assert_eq!(gemini.text, vec!["World"]);
        assert_eq!(
            normalize_finish_reason(gemini.finish_reason.as_deref().unwrap()),
            "stop"
        );
    }

    #[test]
    fn anthropic_usage_keeps_cache_read_and_creation_tokens_separate() {
        let chunk = normalize_anthropic_event(
            Some("message_delta"),
            &json!({
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn"},
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 3,
                    "cache_read_input_tokens": 7,
                    "cache_creation_input_tokens": 5
                }
            }),
        )
        .expect("Anthropic usage event should normalize");
        let usage = chunk.usage.expect("usage should be present");
        assert_eq!(usage.input_tokens, Some(12));
        assert_eq!(usage.output_tokens, Some(3));
        assert_eq!(usage.cached_input_tokens, Some(12));
        assert_eq!(usage.cache_read_input_tokens, Some(7));
        assert_eq!(usage.cache_write_input_tokens, Some(5));
    }

    #[test]
    fn anthropic_usage_recovers_nested_cache_creation_breakdown() {
        let chunk = normalize_anthropic_event(
            Some("message_delta"),
            &json!({
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn"},
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 3,
                    "cache_read_input_tokens": 7,
                    "cache_creation_input_tokens": 0,
                    "cache_creation": {
                        "ephemeral_5m_input_tokens": 2,
                        "ephemeral_1h_input_tokens": 3
                    }
                }
            }),
        )
        .expect("Anthropic nested cache usage should normalize");
        let usage = chunk.usage.expect("usage should be present");
        assert_eq!(usage.cache_read_input_tokens, Some(7));
        assert_eq!(usage.cache_write_input_tokens, Some(5));
        assert_eq!(usage.cached_input_tokens, Some(12));
    }

    #[test]
    fn anthropic_usage_prefers_nonzero_top_level_cache_creation_counter() {
        let chunk = normalize_anthropic_event(
            Some("message_start"),
            &json!({
                "type": "message_start",
                "message": {
                    "usage": {
                        "input_tokens": 12,
                        "cache_creation_input_tokens": 9,
                        "cache_creation": {
                            "ephemeral_5m_input_tokens": 2,
                            "ephemeral_1h_input_tokens": 3
                        }
                    }
                }
            }),
        )
        .expect("Anthropic message_start usage should normalize");
        let usage = chunk.usage.expect("usage should be present");
        assert_eq!(usage.cache_write_input_tokens, Some(9));
    }

    #[test]
    fn usage_counter_sums_fail_closed_on_u64_overflow() {
        let value = json!({
            "first": u64::MAX,
            "second": 1
        });
        assert_eq!(sum_u64_fields(&value, &["first", "second"]), None);
    }

    #[test]
    fn anthropic_split_usage_snapshots_are_merged_for_latest_event() {
        let start = normalize_frame(
            ProviderFamily::Anthropic,
            &SseFrame {
                event: Some("message_start".into()),
                data: json!({
                    "type": "message_start",
                    "message": {
                        "usage": {
                            "input_tokens": 12,
                            "cache_read_input_tokens": 7,
                            "cache_creation_input_tokens": 5
                        }
                    }
                })
                .to_string(),
            },
        )
        .expect("message_start should normalize");
        let delta = normalize_frame(
            ProviderFamily::Anthropic,
            &SseFrame {
                event: Some("message_delta".into()),
                data: json!({
                    "type": "message_delta",
                    "delta": {"stop_reason": "end_turn"},
                    "usage": {"output_tokens": 3}
                })
                .to_string(),
            },
        )
        .expect("message_delta should normalize");

        let mut state = ProviderStreamState::new(ProviderFamily::Anthropic);
        let mut start = start;
        state.observe(&start).unwrap();
        state.merge_usage_snapshot(&mut start);
        let mut delta = delta;
        state.observe(&delta).unwrap();
        state.merge_usage_snapshot(&mut delta);

        let usage = delta.usage.expect("merged usage should be present");
        assert_eq!(usage.input_tokens, Some(12));
        assert_eq!(usage.output_tokens, Some(3));
        assert_eq!(usage.cache_read_input_tokens, Some(7));
        assert_eq!(usage.cache_write_input_tokens, Some(5));
        assert_eq!(usage.cached_input_tokens, Some(12));
    }

    #[test]
    fn openai_finish_reason_or_done_provides_terminal_evidence() {
        let finish_chunk = normalize_frame(
            ProviderFamily::OpenAi,
            &SseFrame {
                event: None,
                data: json!({
                    "choices": [{"delta": {}, "finish_reason": "length"}]
                })
                .to_string(),
            },
        )
        .unwrap();
        let mut finish_only = ProviderStreamState::new(ProviderFamily::OpenAi);
        finish_only.observe(&finish_chunk).unwrap();
        assert_eq!(finish_only.finish_reason().unwrap(), "length");

        let done = normalize_frame(
            ProviderFamily::OpenAi,
            &SseFrame {
                event: None,
                data: "[DONE]".into(),
            },
        )
        .unwrap();
        let mut completed = ProviderStreamState::new(ProviderFamily::OpenAi);
        completed.observe(&finish_chunk).unwrap();
        completed.observe(&done).unwrap();
        assert_eq!(completed.finish_reason().unwrap(), "length");
    }

    #[test]
    fn anthropic_requires_message_stop_after_message_delta() {
        let delta = normalize_frame(
            ProviderFamily::Anthropic,
            &SseFrame {
                event: Some("message_delta".into()),
                data: json!({
                    "type": "message_delta",
                    "delta": {"stop_reason": "end_turn"}
                })
                .to_string(),
            },
        )
        .unwrap();
        let mut interrupted = ProviderStreamState::new(ProviderFamily::Anthropic);
        interrupted.observe(&delta).unwrap();
        let error = interrupted.finish_reason().unwrap_err();
        assert_eq!(error.code, "provider_stream_interrupted");

        let stop = normalize_frame(
            ProviderFamily::Anthropic,
            &SseFrame {
                event: Some("message_stop".into()),
                data: json!({"type": "message_stop", "stop_reason": "end_turn"}).to_string(),
            },
        )
        .unwrap();
        let mut completed = ProviderStreamState::new(ProviderFamily::Anthropic);
        completed.observe(&delta).unwrap();
        completed.observe(&stop).unwrap();
        assert_eq!(completed.finish_reason().unwrap(), "stop");
    }

    #[test]
    fn gemini_finish_reason_is_terminal_and_post_terminal_frames_are_rejected() {
        let terminal = normalize_frame(
            ProviderFamily::Gemini,
            &SseFrame {
                event: None,
                data: json!({
                    "candidates": [{"content": {"parts": [{"text": "done"}]}, "finishReason": "STOP"}]
                })
                .to_string(),
            },
        )
        .unwrap();
        let trailing = normalize_frame(
            ProviderFamily::Gemini,
            &SseFrame {
                event: None,
                data: json!({
                    "candidates": [{"content": {"parts": [{"text": "late"}]}}]
                })
                .to_string(),
            },
        )
        .unwrap();
        let mut state = ProviderStreamState::new(ProviderFamily::Gemini);
        state.observe(&terminal).unwrap();
        let error = state.observe(&trailing).unwrap_err();
        assert_eq!(error.code, "provider_protocol_error");
    }

    #[test]
    fn empty_stream_never_completes() {
        let error = ProviderStreamState::new(ProviderFamily::OpenAi)
            .finish_reason()
            .unwrap_err();
        assert_eq!(error.code, "provider_stream_interrupted");
    }

    #[test]
    fn incomplete_final_sse_frame_is_rejected() {
        let mut decoder = SseDecoder::default();
        decoder
            .push(b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}")
            .unwrap();
        let error = decoder.finish().unwrap_err();
        assert_eq!(error.code, "provider_stream_interrupted");
    }

    #[test]
    fn native_fields_cannot_override_security_or_canonical_fields() {
        let input = prepared_input(
            "provider_0123456789abcdef0123456789abcdef",
            r#"{"native":{"model":"override"}}"#,
        );
        let parameters = input
            .provider_parameters()
            .expect("prepared parameters should decode");

        assert!(build_openai_prepared_body(&input, &parameters).is_err());
    }

    #[test]
    fn explicitly_unsupported_parameters_are_rejected_at_the_native_boundary() {
        let input = prepared_input(
            "provider_0123456789abcdef0123456789abcdef",
            r#"{"topK":40}"#,
        );
        let parameters = input
            .provider_parameters()
            .expect("prepared parameters should decode");
        let error = build_openai_prepared_body(&input, &parameters).unwrap_err();
        assert_eq!(error.code, "unsupported_parameter");
        assert!(error.message.contains("topK"));
    }

    fn prepared_input(provider_profile_id: &str, parameters_json: &str) -> FrozenProviderInput {
        FrozenProviderInput::freeze(crate::prepared_provider_input::FreezeProviderInput {
            id: "provider_input_0123456789abcdef0123456789abcdef",
            attempt_id: "attempt_0123456789abcdef0123456789abcdef",
            run_id: "run_0123456789abcdef0123456789abcdef",
            provider_profile_id,
            model: "example-model",
            messages: &[FrozenProviderMessage {
                role: "user".into(),
                content: "Hello from the frozen input".into(),
            }],
            parameters_json,
            created_at_ms: 1_700_000_000_000,
        })
        .expect("prepared provider input should freeze")
    }

    fn prepared_input_with_messages(
        provider_profile_id: &str,
        parameters_json: &str,
        messages: &[FrozenProviderMessage],
    ) -> FrozenProviderInput {
        FrozenProviderInput::freeze(crate::prepared_provider_input::FreezeProviderInput {
            id: "provider_input_0123456789abcdef0123456789abcdef",
            attempt_id: "attempt_0123456789abcdef0123456789abcdef",
            run_id: "run_0123456789abcdef0123456789abcdef",
            provider_profile_id,
            model: "example-model",
            messages,
            parameters_json,
            created_at_ms: 1_700_000_000_000,
        })
        .expect("prepared provider input should freeze")
    }

    fn cache_policy_parameters(
        mode: ProviderCacheMode,
        behavior: ProviderCacheUnsupportedBehavior,
        breakpoints: &[&str],
        ttl_seconds: Option<u64>,
    ) -> String {
        let policy = ProviderCachePolicy {
            schema_version: 1,
            policy_id: "cache_policy_gateway_test".into(),
            revision_id: "cache_revision_gateway_test".into(),
            scope: crate::provider_cache_plan::CachePolicyScope {
                profile_id: "profile_default".into(),
                project_id: None,
                workflow_id: None,
                provider_profile_id: Some("provider_0123456789abcdef0123456789abcdef".into()),
                model_profile_id: None,
            },
            local: crate::provider_cache_plan::LocalCachePolicy {
                enabled: true,
                encryption: crate::provider_cache_plan::LocalCacheEncryption::NativeProfileKey,
                max_bytes: 1024,
                default_ttl_seconds: None,
                eviction: crate::provider_cache_plan::LocalCacheEviction::Lru,
                allowed_object_kinds: vec!["compiled-context".into()],
                response_reuse: None,
                secure_delete: None,
            },
            provider_native: crate::provider_cache_plan::ProviderNativeCachePolicy {
                mode,
                stable_prefix_planning: true,
                ttl_seconds,
                cache_key_strategy: None,
                cache_breakpoints: breakpoints.iter().map(|value| (*value).into()).collect(),
                unsupported_behavior: behavior,
                evidence_policy: "provider-reported-only".into(),
                warmup: None,
            },
            data_classes_allowed: vec!["public".into()],
            metrics_enabled: None,
            created_at: "2026-01-01T00:00:00Z".into(),
        };
        json!({"cachePolicy": policy}).to_string()
    }

    #[test]
    fn prepared_input_compiles_the_expected_openai_payload() {
        let provider_id = "provider_0123456789abcdef0123456789abcdef";
        let frozen = prepared_input(provider_id, r#"{"temperature":0.2}"#);
        let parameters = frozen
            .provider_parameters()
            .expect("parameters should parse");
        let prepared = build_openai_prepared_body(&frozen, &parameters)
            .expect("prepared OpenAI payload should compile");

        assert_eq!(
            prepared,
            json!({
                "model": "example-model",
                "stream": true,
                "stream_options": {"include_usage": true},
                "messages": [{
                    "role": "user",
                    "content": "Hello from the frozen input"
                }],
                "temperature": 0.2
            })
        );
    }

    #[test]
    fn prepared_input_compiles_the_expected_openai_responses_payload() {
        let provider_id = "provider_0123456789abcdef0123456789abcdef";
        let frozen = prepared_input(
            provider_id,
            r#"{"maxOutputTokens":512,"reasoningEffort":"high","jsonMode":true}"#,
        );
        let parameters = frozen
            .provider_parameters()
            .expect("parameters should parse");
        let prepared = build_openai_responses_prepared_body(&frozen, &parameters)
            .expect("prepared OpenAI Responses payload should compile");

        assert_eq!(prepared["model"], "example-model");
        assert_eq!(prepared["stream"], true);
        assert_eq!(prepared["store"], false);
        assert_eq!(prepared["input"][0]["role"], "user");
        assert_eq!(
            prepared["input"][0]["content"],
            "Hello from the frozen input"
        );
        assert_eq!(prepared["max_output_tokens"], 512);
        assert_eq!(prepared["reasoning"]["effort"], "high");
        assert_eq!(prepared["text"]["format"]["type"], "json_object");
        assert!(prepared.get("messages").is_none());
        assert!(prepared.get("response_format").is_none());
    }

    #[test]
    fn first_party_openai_uses_responses_while_compatible_profiles_keep_chat_completions() {
        assert_eq!(
            provider_family("openai").expect("OpenAI should have a native adapter"),
            ProviderFamily::OpenAiResponses
        );
        assert_eq!(
            provider_family("openai_compatible")
                .expect("compatible profile should have an adapter"),
            ProviderFamily::OpenAi
        );
        assert_eq!(
            provider_family("deepseek").expect("DeepSeek should use the OpenAI Chat adapter"),
            ProviderFamily::OpenAi
        );
        assert_eq!(
            provider_family("local").expect("local profile should have an adapter"),
            ProviderFamily::OpenAi
        );
    }

    #[test]
    fn responses_stream_normalizes_typed_text_usage_and_terminal_events() {
        let delta = normalize_frame(
            ProviderFamily::OpenAiResponses,
            &SseFrame {
                event: Some("response.output_text.delta".into()),
                data: r#"{"type":"response.output_text.delta","delta":"Hello"}"#.into(),
            },
        )
        .expect("Responses text delta should normalize");
        assert_eq!(delta.text, vec!["Hello"]);

        let completed = normalize_frame(
            ProviderFamily::OpenAiResponses,
            &SseFrame {
                event: Some("response.completed".into()),
                data: r#"{"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":12,"output_tokens":8,"input_tokens_details":{"cached_tokens":4},"output_tokens_details":{"reasoning_tokens":2}}}}"#.into(),
            },
        )
        .expect("Responses completion should normalize");
        let mut state = ProviderStreamState::new(ProviderFamily::OpenAiResponses);
        state.observe(&delta).unwrap();
        let mut completed = completed;
        state.observe(&completed).unwrap();
        state.merge_usage_snapshot(&mut completed);
        assert_eq!(completed.finish_reason.as_deref(), Some("stop"));
        assert_eq!(
            completed.terminal_marker,
            Some(ProviderTerminalMarker::OpenAiResponsesTerminal)
        );
        assert_eq!(
            completed
                .usage
                .as_ref()
                .and_then(|usage| usage.input_tokens),
            Some(12)
        );
        assert_eq!(
            completed
                .usage
                .as_ref()
                .and_then(|usage| usage.cache_read_input_tokens),
            Some(4)
        );
        assert_eq!(state.finish_reason().unwrap(), "stop");
    }

    #[test]
    fn prepared_input_translates_anthropic_and_gemini_without_renderer_payloads() {
        let provider_id = "provider_0123456789abcdef0123456789abcdef";
        let frozen = prepared_input(provider_id, r#"{"maxOutputTokens":128}"#);
        let parameters = frozen
            .provider_parameters()
            .expect("parameters should parse");
        let anthropic = build_anthropic_prepared_body(&frozen, &parameters)
            .expect("Anthropic payload should compile");
        let gemini = build_gemini_prepared_body(&frozen, &parameters)
            .expect("Gemini payload should compile");
        assert_eq!(
            anthropic["messages"][0]["content"],
            "Hello from the frozen input"
        );
        assert_eq!(
            gemini["contents"][0]["parts"][0]["text"],
            "Hello from the frozen input"
        );
    }

    #[test]
    fn anthropic_explicit_system_cache_is_translated_to_a_text_block() {
        let provider_id = "provider_0123456789abcdef0123456789abcdef";
        let messages = vec![
            FrozenProviderMessage {
                role: "system".into(),
                content: "stable instructions".into(),
            },
            FrozenProviderMessage {
                role: "user".into(),
                content: "hello".into(),
            },
        ];
        let frozen = prepared_input_with_messages(
            provider_id,
            &cache_policy_parameters(
                ProviderCacheMode::Explicit,
                ProviderCacheUnsupportedBehavior::Block,
                &["system"],
                None,
            ),
            &messages,
        );
        let parameters = frozen
            .provider_parameters()
            .expect("cache policy parameters should decode");
        let plan = ProviderCachePlan::compile_from_parameters_json(
            &frozen.parameters_json,
            provider_id,
            &frozen.model,
            &frozen.content_sha256,
            "anthropic",
            &frozen.messages,
        )
        .expect("system cache policy should compile")
        .expect("cache plan should be present");
        let body = build_anthropic_prepared_body_with_cache_plan(&frozen, &parameters, Some(&plan))
            .expect("Anthropic system cache body should compile");

        assert_eq!(body["system"][0]["type"], "text");
        assert_eq!(body["system"][0]["text"], "stable instructions");
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        assert!(body["system"][0]["cache_control"].get("ttl").is_none());
        assert_eq!(body["messages"][0]["content"], "hello");
    }

    #[test]
    fn anthropic_explicit_last_message_cache_supports_five_and_sixty_minute_ttls() {
        let provider_id = "provider_0123456789abcdef0123456789abcdef";
        for (ttl_seconds, expected_ttl) in [(300_u64, "5m"), (3_600_u64, "1h")] {
            let messages = vec![
                FrozenProviderMessage {
                    role: "user".into(),
                    content: "first".into(),
                },
                FrozenProviderMessage {
                    role: "assistant".into(),
                    content: "final".into(),
                },
            ];
            let frozen = prepared_input_with_messages(
                provider_id,
                &cache_policy_parameters(
                    ProviderCacheMode::Explicit,
                    ProviderCacheUnsupportedBehavior::Block,
                    &["last-message"],
                    Some(ttl_seconds),
                ),
                &messages,
            );
            let parameters = frozen
                .provider_parameters()
                .expect("cache policy parameters should decode");
            let plan = ProviderCachePlan::compile_from_parameters_json(
                &frozen.parameters_json,
                provider_id,
                &frozen.model,
                &frozen.content_sha256,
                "anthropic",
                &frozen.messages,
            )
            .expect("last-message cache policy should compile")
            .expect("cache plan should be present");
            let body =
                build_anthropic_prepared_body_with_cache_plan(&frozen, &parameters, Some(&plan))
                    .expect("Anthropic last-message cache body should compile");

            assert_eq!(body["messages"][0]["content"], "first");
            assert_eq!(body["messages"][1]["content"][0]["type"], "text");
            assert_eq!(body["messages"][1]["content"][0]["text"], "final");
            assert_eq!(
                body["messages"][1]["content"][0]["cache_control"]["ttl"],
                expected_ttl
            );
        }
    }

    #[test]
    fn anthropic_last_user_cache_targets_the_last_user_when_final_message_is_assistant() {
        let provider_id = "provider_0123456789abcdef0123456789abcdef";
        let messages = vec![
            FrozenProviderMessage {
                role: "user".into(),
                content: "question".into(),
            },
            FrozenProviderMessage {
                role: "assistant".into(),
                content: "answer".into(),
            },
        ];
        let frozen = prepared_input_with_messages(
            provider_id,
            &cache_policy_parameters(
                ProviderCacheMode::Explicit,
                ProviderCacheUnsupportedBehavior::Block,
                &["last-user"],
                Some(300),
            ),
            &messages,
        );
        let parameters = frozen
            .provider_parameters()
            .expect("cache policy parameters should decode");
        let plan = ProviderCachePlan::compile_from_parameters_json(
            &frozen.parameters_json,
            provider_id,
            &frozen.model,
            &frozen.content_sha256,
            "anthropic",
            &frozen.messages,
        )
        .expect("last-user cache policy should compile")
        .expect("cache plan should be present");
        let body = build_anthropic_prepared_body_with_cache_plan(&frozen, &parameters, Some(&plan))
            .expect("Anthropic last-user cache body should compile");

        assert!(body["messages"][0]["content"].is_array());
        assert_eq!(body["messages"][0]["content"][0]["text"], "question");
        assert_eq!(body["messages"][1]["content"], "answer");
    }

    #[test]
    fn anthropic_without_cache_policy_preserves_string_content_shapes() {
        let provider_id = "provider_0123456789abcdef0123456789abcdef";
        let messages = vec![
            FrozenProviderMessage {
                role: "system".into(),
                content: "stable instructions".into(),
            },
            FrozenProviderMessage {
                role: "user".into(),
                content: "hello".into(),
            },
        ];
        let frozen = prepared_input_with_messages(provider_id, "{}", &messages);
        let parameters = frozen
            .provider_parameters()
            .expect("empty parameters should decode");
        let body = build_anthropic_prepared_body(&frozen, &parameters)
            .expect("uncached Anthropic body should compile");

        assert_eq!(body["system"], "stable instructions");
        assert_eq!(body["messages"][0]["content"], "hello");
    }

    #[test]
    fn openai_and_gemini_explicit_cache_controls_fall_back_or_block() {
        let provider_id = "provider_0123456789abcdef0123456789abcdef";
        let messages = vec![FrozenProviderMessage {
            role: "user".into(),
            content: "hello".into(),
        }];
        let fallback_parameters = cache_policy_parameters(
            ProviderCacheMode::Explicit,
            ProviderCacheUnsupportedBehavior::SendUncached,
            &["system"],
            None,
        );
        let frozen = prepared_input_with_messages(provider_id, &fallback_parameters, &messages);
        for provider_type in ["openai", "gemini"] {
            let plan = ProviderCachePlan::compile_from_parameters_json(
                &frozen.parameters_json,
                provider_id,
                &frozen.model,
                &frozen.content_sha256,
                provider_type,
                &frozen.messages,
            )
            .expect("unsupported controls should be conservatively planned")
            .expect("cache plan should be present");
            assert!(
                plan.fallback_reason.is_some(),
                "{provider_type} should fall back"
            );
            assert!(!plan.explicit_anthropic_system);
        }

        let blocked_parameters = cache_policy_parameters(
            ProviderCacheMode::Explicit,
            ProviderCacheUnsupportedBehavior::Block,
            &["system"],
            None,
        );
        let blocked = prepared_input_with_messages(provider_id, &blocked_parameters, &messages);
        for provider_type in ["openai", "gemini"] {
            let error = ProviderCachePlan::compile_from_parameters_json(
                &blocked.parameters_json,
                provider_id,
                &blocked.model,
                &blocked.content_sha256,
                provider_type,
                &blocked.messages,
            )
            .expect_err("block policy must reject unverified provider controls");
            assert_eq!(error.code, "cache_policy_unsupported");
        }
    }

    #[test]
    fn anthropic_legacy_thinking_uses_budget_form_and_safe_default_output_room() {
        let provider_id = "provider_0123456789abcdef0123456789abcdef";
        let mut frozen = prepared_input(provider_id, r#"{"reasoningEffort":"high"}"#);
        frozen.model = "claude-sonnet-4-5".into();
        let parameters = frozen
            .provider_parameters()
            .expect("parameters should parse");
        let body = build_anthropic_prepared_body(&frozen, &parameters)
            .expect("legacy thinking payload should compile");
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], 16_384);
        assert_eq!(body["max_tokens"], 17_408);
        assert!(body.get("output_config").is_none());
    }

    #[test]
    fn anthropic_legacy_minimal_thinking_uses_provider_minimum_budget() {
        let provider_id = "provider_0123456789abcdef0123456789abcdef";
        let mut frozen = prepared_input(provider_id, r#"{"reasoningEffort":"minimal"}"#);
        frozen.model = "claude-sonnet-4-5".into();
        let parameters = frozen
            .provider_parameters()
            .expect("parameters should parse");
        let body = build_anthropic_prepared_body(&frozen, &parameters)
            .expect("minimal legacy thinking payload should compile");
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], 1_024);
        assert_eq!(body["max_tokens"], 2_048);
    }

    #[test]
    fn anthropic_adaptive_thinking_uses_output_config_effort() {
        let provider_id = "provider_0123456789abcdef0123456789abcdef";
        let mut frozen = prepared_input(provider_id, r#"{"reasoningEffort":"high"}"#);
        frozen.model = "claude-sonnet-4-6".into();
        let parameters = frozen
            .provider_parameters()
            .expect("parameters should parse");
        let body = build_anthropic_prepared_body(&frozen, &parameters)
            .expect("adaptive thinking payload should compile");
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert_eq!(body["output_config"]["effort"], "high");
        assert_eq!(body["max_tokens"], 4_096);
    }

    #[test]
    fn anthropic_adaptive_thinking_does_not_apply_legacy_budget_guard() {
        let provider_id = "provider_0123456789abcdef0123456789abcdef";
        let mut frozen = prepared_input(
            provider_id,
            r#"{"reasoningEffort":"high","maxOutputTokens":1024}"#,
        );
        frozen.model = "claude-opus-4-6".into();
        let parameters = frozen
            .provider_parameters()
            .expect("parameters should parse");
        let body = build_anthropic_prepared_body(&frozen, &parameters)
            .expect("adaptive thinking should not use the legacy budget guard");
        assert_eq!(body["max_tokens"], 1_024);
        assert_eq!(body["thinking"]["type"], "adaptive");
    }

    #[test]
    fn anthropic_legacy_thinking_rejects_explicit_output_cap_at_or_below_budget() {
        let provider_id = "provider_0123456789abcdef0123456789abcdef";
        let mut frozen = prepared_input(
            provider_id,
            r#"{"reasoningEffort":"high","maxOutputTokens":1024}"#,
        );
        frozen.model = "claude-opus-4-5".into();
        let parameters = frozen
            .provider_parameters()
            .expect("parameters should parse");
        let error = build_anthropic_prepared_body(&frozen, &parameters)
            .expect_err("an explicit cap below the thinking budget must fail closed");
        assert_eq!(error.code, "invalid_parameter");
        assert!(error.message.contains("maxOutputTokens"));
    }

    #[test]
    fn prepared_request_builder_rejects_a_foreign_provider_profile() {
        let frozen = prepared_input("provider_0123456789abcdef0123456789abcdef", "{}");
        let profile = ProviderProfileRecord {
            id: "provider_ffffffffffffffffffffffffffffffff".into(),
            ..test_profile("openai", "none")
        };
        let client = Client::builder().build().unwrap();
        let error =
            build_prepared_stream_request(&client, ProviderFamily::OpenAi, &profile, None, &frozen)
                .expect_err("foreign provider profile must fail closed");
        assert_eq!(error.code, "prepared_input_scope_conflict");
    }

    #[test]
    fn prepared_request_builder_rejects_tampering_before_http_dispatch() {
        let mut frozen = prepared_input(
            "provider_0123456789abcdef0123456789abcdef",
            r#"{"temperature":0.2}"#,
        );
        frozen.messages[0].content = "tampered after preparation".into();
        let profile = test_profile("openai", "none");
        let client = Client::builder().build().unwrap();
        let error =
            build_prepared_stream_request(&client, ProviderFamily::OpenAi, &profile, None, &frozen)
                .expect_err("tampered native storage input must fail before HTTP dispatch");
        assert_eq!(error.code, "prepared_input_integrity_failed");
    }

    #[test]
    fn prepared_request_builder_rejects_unsupported_parameters_before_http_dispatch() {
        let frozen = prepared_input(
            "provider_0123456789abcdef0123456789abcdef",
            r#"{"topK":40}"#,
        );
        let profile = test_profile("openai", "none");
        let client = Client::builder().build().unwrap();
        let error =
            build_prepared_stream_request(&client, ProviderFamily::OpenAi, &profile, None, &frozen)
                .expect_err("unsupported prepared parameter must fail before HTTP dispatch");
        assert_eq!(error.code, "unsupported_parameter");
        assert!(error.message.contains("topK"));
    }

    #[test]
    fn prepared_adapters_fail_closed_for_tool_messages_until_typed_tool_support_exists() {
        let input =
            FrozenProviderInput::freeze(crate::prepared_provider_input::FreezeProviderInput {
                id: "provider_input_0123456789abcdef0123456789abcdef",
                attempt_id: "attempt_0123456789abcdef0123456789abcdef",
                run_id: "run_0123456789abcdef0123456789abcdef",
                provider_profile_id: "provider_0123456789abcdef0123456789abcdef",
                model: "example-model",
                messages: &[FrozenProviderMessage {
                    role: "tool".into(),
                    content: "untyped tool result".into(),
                }],
                parameters_json: "{}",
                created_at_ms: 1_700_000_000_000,
            })
            .expect("the provider-neutral frozen contract permits a tool role");
        let parameters = input
            .provider_parameters()
            .expect("parameters should decode");
        assert_eq!(
            build_anthropic_prepared_body(&input, &parameters)
                .expect_err("Anthropic needs typed tool-use provenance")
                .code,
            "unsupported_message_role"
        );
        assert_eq!(
            build_gemini_prepared_body(&input, &parameters)
                .expect_err("Gemini needs typed function-response provenance")
                .code,
            "unsupported_message_role"
        );
    }

    #[test]
    fn model_catalogs_are_bounded_deduplicated_and_plain_text() {
        let models = parse_model_list(ProviderFamily::Gemini, &json!({
            "models":[
                {"name":"models/gemini-test","displayName":"Gemini Test","supportedGenerationMethods":["generateContent"]},
                {"name":"models/gemini-test","displayName":"Duplicate","supportedGenerationMethods":["generateContent"]},
                {"name":"models/embed","supportedGenerationMethods":["embedContent"]}
            ]
        })).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gemini-test");
    }

    #[test]
    fn model_catalog_labels_reject_control_and_oversized_text() {
        let oversized = "x".repeat(MAX_MODEL_ID_BYTES + 1);
        let models = parse_model_list(
            ProviderFamily::OpenAi,
            &json!({
                "data": [
                    {
                        "id": "safe-model",
                        "display_name": "  Safe model  ",
                        "owned_by": "  provider  "
                    },
                    {
                        "id": "control-model",
                        "display_name": "bad\nlabel",
                        "owned_by": "bad\towner"
                    },
                    {
                        "id": "oversized-model",
                        "display_name": oversized.clone(),
                        "owned_by": oversized
                    }
                ]
            }),
        )
        .expect("model catalog should remain valid when optional labels are malformed");

        assert_eq!(models.len(), 3);
        let safe = models
            .iter()
            .find(|model| model.id == "safe-model")
            .expect("safe model should be retained");
        assert_eq!(safe.display_name, "Safe model");
        assert_eq!(safe.owned_by.as_deref(), Some("provider"));

        let control = models
            .iter()
            .find(|model| model.id == "control-model")
            .expect("control-label model should be retained");
        assert_eq!(control.display_name, "control-model");
        assert_eq!(control.owned_by, None);

        let oversized = models
            .iter()
            .find(|model| model.id == "oversized-model")
            .expect("oversized-label model should be retained");
        assert_eq!(oversized.display_name, "oversized-model");
        assert_eq!(oversized.owned_by, None);
    }

    #[test]
    fn arbitrary_compatible_models_do_not_gain_capabilities_from_their_names() {
        let models = parse_model_list(
            ProviderFamily::OpenAi,
            &json!({
                "data": [
                    {
                        "id": "omnia-smoke-model",
                        "object": "model",
                        "owned_by": "omnia-local-smoke"
                    },
                    {
                        "id": "gpt-5-local-reasoning-vision",
                        "object": "model",
                        "owned_by": "compatible-runtime"
                    }
                ]
            }),
        )
        .unwrap();

        assert_eq!(models.len(), 2);
        for model in models {
            assert_eq!(
                model.capabilities,
                ProviderModelCapabilities {
                    streaming: true,
                    tools: None,
                    vision: None,
                    reasoning: None,
                    source: "unknown",
                },
                "{} must not inherit capabilities from provider branding or its model ID",
                model.id
            );
        }
    }

    #[test]
    fn live_catalog_capability_declarations_are_preserved_without_inference() {
        let models = parse_model_list(
            ProviderFamily::OpenAi,
            &json!({
                "data": [{
                    "id": "declared-model",
                    "capabilities": {
                        "tools": true,
                        "vision": false,
                        "reasoning": true
                    }
                }]
            }),
        )
        .unwrap();

        assert_eq!(
            models[0].capabilities,
            ProviderModelCapabilities {
                streaming: true,
                tools: Some(true),
                vision: Some(false),
                reasoning: Some(true),
                source: "provider_live",
            }
        );
    }

    #[test]
    fn secrets_are_redacted_from_remote_error_text() {
        for message in [
            "Authorization: Bearer sk-secret",
            "x-api-key=top-secret",
            "x-goog-api-key: AIza-secret",
            "proxy-authorization: Basic abc",
            "provider echoed sk-proj-secret",
            "upstream URL https://internal.example.test/v1?token=secret",
            r"failed to read C:\Users\alice\.config\provider.json",
            "opaque credential eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepayload1234567890",
            "provider returned access_token=abcdefghijklmnopqrstuvwxyz0123456789",
            "provider echoed the user prompt: unpublished lab notes and private context",
            "provider returned the system prompt: internal routing instructions",
        ] {
            assert_eq!(
                redact_sensitive_text(message),
                "Provider returned a redacted authentication error"
            );
        }
    }

    #[test]
    fn ordinary_remote_error_text_is_preserved_but_bounded() {
        let ordinary = "The requested model is unavailable for this provider";
        assert_eq!(redact_sensitive_text(ordinary), ordinary);

        let long = "safe-provider-detail ".repeat(80);
        let redacted = redact_sensitive_text(&long);
        assert_eq!(redacted.len(), 600);
        assert!(!redacted.contains('\n'));
    }

    #[test]
    fn native_provider_errors_preserve_normalized_metadata() {
        let error = native_provider_error(
            ProviderFailure::retryable(
                "provider_temporarily_unavailable",
                "The provider is temporarily unavailable",
            )
            .with_status(StatusCode::TOO_MANY_REQUESTS)
            .with_retry_after(Some(3_000))
            .with_acceptance(ProviderAcceptanceEvidence::Unknown),
        );

        assert_eq!(error.code, "provider_temporarily_unavailable");
        assert!(error.retryable);
        assert_eq!(error.source, "provider");
        assert_eq!(error.status, Some(429));
        assert_eq!(error.retry_after_ms, Some(3_000));
        assert_eq!(error.acceptance, Some("unknown"));
        assert_eq!(error.error_class, Some(ProviderErrorClass::RateLimit));
        assert!(error.diagnostic_id.starts_with("diag-"));
        assert_eq!(error.diagnostic_id.len(), 41);
        assert_eq!(error.message, "The provider is temporarily unavailable");
    }

    #[test]
    fn provider_http_statuses_project_to_the_allowlisted_error_taxonomy() {
        let cases = [
            (StatusCode::UNAUTHORIZED, ProviderErrorClass::Authentication),
            (StatusCode::FORBIDDEN, ProviderErrorClass::Authorization),
            (StatusCode::PAYMENT_REQUIRED, ProviderErrorClass::Billing),
            (StatusCode::NOT_FOUND, ProviderErrorClass::ModelUnavailable),
            (StatusCode::REQUEST_TIMEOUT, ProviderErrorClass::Timeout),
            (StatusCode::TOO_MANY_REQUESTS, ProviderErrorClass::RateLimit),
            (StatusCode::CONFLICT, ProviderErrorClass::RateLimit),
            (StatusCode::TOO_EARLY, ProviderErrorClass::RateLimit),
            (StatusCode::BAD_REQUEST, ProviderErrorClass::Schema),
            (StatusCode::UNPROCESSABLE_ENTITY, ProviderErrorClass::Schema),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                ProviderErrorClass::Transport,
            ),
            (StatusCode::BAD_GATEWAY, ProviderErrorClass::Transport),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                ProviderErrorClass::Transport,
            ),
            (
                StatusCode::from_u16(418).expect("418 is a valid HTTP status"),
                ProviderErrorClass::Unknown,
            ),
        ];

        for (status, expected) in cases {
            assert_eq!(
                provider_error_class_for_status(status),
                expected,
                "unexpected provider error class for HTTP status {status}"
            );
        }
    }

    #[test]
    fn provider_code_defaults_cover_transport_schema_protocol_and_cancellation() {
        let cases = [
            ("provider_dns_failed", ProviderErrorClass::Dns),
            ("provider_dns_mixed_scope", ProviderErrorClass::Dns),
            ("provider_timeout", ProviderErrorClass::Timeout),
            ("provider_connection_failed", ProviderErrorClass::Transport),
            ("provider_transport_failed", ProviderErrorClass::Transport),
            ("provider_stream_interrupted", ProviderErrorClass::Transport),
            ("provider_protocol_error", ProviderErrorClass::Protocol),
            ("provider_redirect_blocked", ProviderErrorClass::Protocol),
            ("provider_frame_too_large", ProviderErrorClass::Protocol),
            ("provider_response_too_large", ProviderErrorClass::Protocol),
            ("provider_catalog_too_large", ProviderErrorClass::Protocol),
            ("unsupported_parameter", ProviderErrorClass::Schema),
            ("invalid_parameter", ProviderErrorClass::Schema),
            ("invalid_model", ProviderErrorClass::Schema),
            ("cancelled", ProviderErrorClass::Cancelled),
            ("provider_not_yet_mapped", ProviderErrorClass::Unknown),
        ];

        for (code, expected) in cases {
            assert_eq!(
                default_provider_error_class(code),
                expected,
                "unexpected provider error class for code {code}"
            );
        }
    }

    #[test]
    fn provider_error_class_does_not_change_retryability_or_acceptance_evidence() {
        let retryable_unknown = ProviderFailure::retryable(
            "provider_temporarily_unavailable",
            "The provider is temporarily unavailable",
        )
        .with_acceptance(ProviderAcceptanceEvidence::Unknown)
        .with_error_class(ProviderErrorClass::RateLimit);
        assert!(retryable_unknown.retryable);
        assert_eq!(
            retryable_unknown.acceptance,
            ProviderAcceptanceEvidence::Unknown
        );
        assert_eq!(retryable_unknown.error_class, ProviderErrorClass::RateLimit);

        let definitive_rejection = ProviderFailure::new(
            "provider_request_rejected",
            "The provider rejected the request",
        )
        .with_acceptance(ProviderAcceptanceEvidence::NotAccepted)
        .with_error_class(ProviderErrorClass::Authentication);
        assert!(!definitive_rejection.retryable);
        assert_eq!(
            definitive_rejection.acceptance,
            ProviderAcceptanceEvidence::NotAccepted
        );
        assert_eq!(
            definitive_rejection.error_class,
            ProviderErrorClass::Authentication
        );
    }

    #[test]
    fn renderer_facing_request_ids_reject_secret_like_or_header_like_values() {
        for raw_value in [
            "sk-provider-secret",
            "Bearer-token",
            "eyJhbGciOiJub25lIn0",
            "AIza-provider-secret",
            "authorization:value",
            "safe id with spaces",
            "request-id\r\nsecret",
        ] {
            let mut headers = header::HeaderMap::new();
            if let Ok(value) = header::HeaderValue::from_str(raw_value) {
                headers.insert("x-request-id", value);
                assert_eq!(provider_request_id(&headers), None, "{raw_value:?}");
            }
        }

        let mut headers = header::HeaderMap::new();
        headers.insert(
            "x-request-id",
            header::HeaderValue::from_static("req_1234.safe-id:abcd"),
        );
        assert_eq!(
            provider_request_id(&headers).as_deref(),
            Some("req_1234.safe-id:abcd")
        );
    }

    #[test]
    fn openai_scope_headers_are_rejected_for_non_openai_profiles() {
        for (provider_type, auth_scheme) in [
            ("anthropic", "api_key_header"),
            ("gemini", "api_key_header"),
            ("local", "api_key_header"),
            ("deepseek", "bearer"),
        ] {
            let mut profile = test_profile(provider_type, auth_scheme);
            profile.organization_id = Some("org_should_not_cross_scope".into());
            profile.remote_project_id = Some("project_should_not_cross_scope".into());
            let error = apply_auth(
                Client::builder()
                    .build()
                    .unwrap()
                    .post("https://provider.invalid"),
                provider_family(provider_type).unwrap(),
                &profile,
                Some("secret"),
            )
            .expect_err("OpenAI routing metadata must not cross provider scopes");
            assert_eq!(error.code, "invalid_provider_profile");
        }
    }

    #[test]
    fn openai_scope_headers_are_emitted_only_for_openai_profiles() {
        for provider_type in ["openai", "openai_compatible"] {
            let mut profile = test_profile(provider_type, "bearer");
            profile.organization_id = Some("org_omnia".into());
            profile.remote_project_id = Some("project_omnia".into());
            let request = apply_auth(
                Client::builder()
                    .build()
                    .unwrap()
                    .post("https://provider.invalid"),
                ProviderFamily::OpenAi,
                &profile,
                Some("secret"),
            )
            .expect("OpenAI profiles may use OpenAI routing metadata")
            .build()
            .unwrap();
            assert_eq!(
                request
                    .headers()
                    .get("OpenAI-Organization")
                    .and_then(|value| value.to_str().ok()),
                Some("org_omnia")
            );
            assert_eq!(
                request
                    .headers()
                    .get("OpenAI-Project")
                    .and_then(|value| value.to_str().ok()),
                Some("project_omnia")
            );
        }

        let mut local = test_profile("local", "bearer");
        local.organization_id = None;
        local.remote_project_id = None;
        let request = apply_auth(
            Client::builder()
                .build()
                .unwrap()
                .post("http://127.0.0.1:11434"),
            ProviderFamily::OpenAi,
            &local,
            Some("secret"),
        )
        .expect("local OpenAI-compatible wire requests may omit OpenAI routing metadata")
        .build()
        .unwrap();
        assert!(!request.headers().contains_key("OpenAI-Organization"));
        assert!(!request.headers().contains_key("OpenAI-Project"));
    }

    #[test]
    fn metadata_and_mixed_scope_destinations_are_rejected() {
        assert!(
            validate_resolved_addresses("http", ["169.254.169.254:80".parse().unwrap()], true,)
                .is_err()
        );
        assert!(validate_resolved_addresses(
            "https",
            [
                "127.0.0.1:443".parse().unwrap(),
                "8.8.8.8:443".parse().unwrap(),
            ],
            true,
        )
        .is_err());
    }

    #[test]
    fn resolved_destination_policy_rejects_mixed_scope_dns_answers() {
        let error = validate_resolved_addresses(
            "https",
            [
                SocketAddr::from(([93, 184, 216, 34], 443)),
                SocketAddr::from(([127, 0, 0, 1], 443)),
            ],
            true,
        )
        .unwrap_err();
        assert_eq!(error.code, "provider_dns_mixed_scope");
    }

    #[test]
    fn resolved_destination_policy_requires_local_grant_and_https_for_public_hosts() {
        let local = [SocketAddr::from(([127, 0, 0, 1], 80))];
        assert_eq!(
            validate_resolved_addresses("http", local, false)
                .unwrap_err()
                .code,
            "local_network_permission_required"
        );
        assert!(validate_resolved_addresses("http", local, true).is_ok());

        let metadata = [SocketAddr::from(([169, 254, 169, 254], 80))];
        assert_eq!(
            validate_resolved_addresses("http", metadata, true)
                .unwrap_err()
                .code,
            "provider_destination_blocked"
        );

        let public = [SocketAddr::from(([93, 184, 216, 34], 80))];
        assert_eq!(
            validate_resolved_addresses("http", public, false)
                .unwrap_err()
                .code,
            "insecure_provider_transport"
        );
        assert!(validate_resolved_addresses("https", public, false).is_ok());
    }

    #[test]
    fn special_and_ipv4_mapped_addresses_are_not_treated_as_public_internet() {
        for address in [
            "0.0.0.1",
            "100.64.0.1",
            "192.0.0.8",
            "192.0.2.1",
            "198.18.0.1",
            "203.0.113.1",
            "240.0.0.1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                is_private_or_local(address.parse().unwrap()),
                "{address} must not be routed as public internet"
            );
        }
        assert!(!is_private_or_local("93.184.216.34".parse().unwrap()));
        assert!(!is_private_or_local(
            "2606:2800:220:1:248:1893:25c8:1946".parse().unwrap()
        ));
    }

    #[test]
    fn unsupported_auth_schemes_fail_closed_before_dispatch() {
        let client = Client::builder().build().unwrap();
        let anthropic = test_profile("anthropic", "custom_header");
        let error = apply_auth(
            client.get("https://provider.invalid"),
            ProviderFamily::Anthropic,
            &anthropic,
            Some("secret"),
        )
        .unwrap_err();
        assert_eq!(error.code, "unsupported_auth_scheme");

        let no_auth = test_profile("local", "none");
        let error = apply_auth(
            client.get("https://provider.invalid"),
            ProviderFamily::OpenAi,
            &no_auth,
            Some("secret"),
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid_provider_profile");
    }

    #[test]
    fn anthropic_auth_schemes_emit_the_selected_header_contract() {
        let client = Client::builder().build().unwrap();
        let api_key = test_profile("anthropic", "api_key_header");
        let api_key_request = apply_auth(
            client.post("https://provider.invalid"),
            ProviderFamily::Anthropic,
            &api_key,
            Some("secret"),
        )
        .expect("Anthropic x-api-key auth should compile")
        .build()
        .unwrap();
        assert_eq!(
            api_key_request
                .headers()
                .get("x-api-key")
                .and_then(|value| value.to_str().ok()),
            Some("secret")
        );
        assert!(!api_key_request.headers().contains_key("authorization"));
        assert_eq!(
            api_key_request
                .headers()
                .get("anthropic-version")
                .and_then(|value| value.to_str().ok()),
            Some(ANTHROPIC_VERSION)
        );

        let bearer = test_profile("anthropic", "bearer");
        let bearer_request = apply_auth(
            Client::builder()
                .build()
                .unwrap()
                .post("https://provider.invalid"),
            ProviderFamily::Anthropic,
            &bearer,
            Some("secret"),
        )
        .expect("Anthropic bearer auth should compile")
        .build()
        .unwrap();
        assert_eq!(
            bearer_request
                .headers()
                .get("authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer secret")
        );
        assert!(!bearer_request.headers().contains_key("x-api-key"));
        assert_eq!(
            bearer_request
                .headers()
                .get("anthropic-version")
                .and_then(|value| value.to_str().ok()),
            Some(ANTHROPIC_VERSION)
        );
        // Bearer keys are plain API credentials; no subscription-token beta.
        assert!(!bearer_request.headers().contains_key("anthropic-beta"));
    }

    #[test]
    fn sse_decoder_rejects_a_single_oversized_network_chunk_before_append() {
        let mut decoder = SseDecoder::default();
        let oversized = vec![b'x'; MAX_FRAME_BYTES + 1];
        let error = decoder
            .push(&oversized)
            .expect_err("a single oversized network chunk must fail closed");
        assert_eq!(error.code, "provider_frame_too_large");
        assert!(decoder.buffer.is_empty());
    }

    #[test]
    fn unavailable_provider_profiles_fail_closed_before_dispatch() {
        for provider_type in ["azure_openai", "custom_adapter"] {
            let error = provider_family(provider_type).unwrap_err();
            assert_eq!(error.code, "provider_not_available");
        }
    }

    #[tokio::test]
    async fn provider_client_keeps_redirects_disabled_and_uses_pinned_addresses() {
        let gateway = ProviderGateway::new().unwrap();
        let destination = spawn_http_response(
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_vec(),
        )
        .await;
        let client = gateway
            .client_for_resolved_origin("provider.invalid", &[destination])
            .unwrap();
        let response = client
            .get("http://provider.invalid/redirect")
            .send()
            .await
            .unwrap();
        let error = validate_http_status(response).await.unwrap_err();
        assert_eq!(error.code, "provider_redirect_blocked");
        assert_eq!(error.status, Some(302));
    }

    #[tokio::test]
    async fn stream_responses_reject_no_content_and_non_sse_successes() {
        let no_content = request_local_response(
            b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".to_vec(),
        )
        .await;
        let error = validate_stream_response(no_content).await.unwrap_err();
        assert_eq!(error.code, "provider_request_rejected");
        assert_eq!(error.status, Some(204));

        for content_type in ["application/json", "text/html"] {
            let response = request_local_response(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
                )
                .into_bytes(),
            )
            .await;
            let error = validate_stream_response(response).await.unwrap_err();
            assert_eq!(error.code, "provider_protocol_error");
            assert_eq!(error.status, Some(200));
        }
    }

    #[tokio::test]
    async fn sse_content_type_is_case_insensitive_and_accepts_parameters() {
        let response = request_local_response(
            b"HTTP/1.1 200 OK\r\nContent-Type: Text/Event-Stream; charset=utf-8\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_vec(),
        )
        .await;
        validate_stream_response(response).await.unwrap();
    }

    #[tokio::test]
    async fn bounded_response_rejects_declared_and_streamed_overflow() {
        let declared = request_local_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n".to_vec(),
        )
        .await;
        let error = read_bounded_response(declared, 8, "too_large")
            .await
            .unwrap_err();
        assert_eq!(error.code, "too_large");

        let streamed = request_local_response(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n9\r\n123456789\r\n0\r\n\r\n"
                .to_vec(),
        )
        .await;
        let error = read_bounded_response(streamed, 8, "too_large")
            .await
            .unwrap_err();
        assert_eq!(error.code, "too_large");
    }

    #[tokio::test]
    async fn provider_errors_are_bounded_sanitized_and_classified() {
        let response = request_local_response(
            b"HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 64\r\nX-Request-Id: safe-id\r\nRetry-After: 3\r\nConnection: close\r\n\r\n{\"error\":{\"message\":\"Authorization: Bearer sk-provider-secret\"}}"
                .to_vec(),
        )
        .await;
        let error = validate_http_status(response).await.unwrap_err();
        assert_eq!(error.code, "provider_request_rejected");
        assert_eq!(error.status, Some(401));
        assert!(!error.retryable);
        assert!(error.message.contains("redacted authentication error"));
        assert!(error.message.contains("request ID safe-id"));
        assert!(error.message.contains("retry after 3000 ms"));
        assert!(!error.message.contains("Retry-After"));
        assert!(!error.message.contains("sk-provider-secret"));
        assert_eq!(error.retry_after_ms, Some(3_000));
    }

    #[tokio::test]
    async fn retryable_provider_statuses_mark_remote_acceptance_unknown() {
        for status_line in ["429 Too Many Requests", "502 Bad Gateway"] {
            let response = request_local_response(
                format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
                )
                .into_bytes(),
            )
            .await;
            let error = validate_http_status(response).await.unwrap_err();
            assert_eq!(error.code, "provider_temporarily_unavailable");
            assert!(error.retryable);
            assert_eq!(error.acceptance, ProviderAcceptanceEvidence::Unknown);
        }
    }

    #[test]
    fn retry_after_delta_seconds_are_normalized_and_bounded() {
        assert_eq!(parse_retry_after_ms("3"), Some(3_000));
        assert_eq!(parse_retry_after_ms(" 0 "), Some(0));
        assert_eq!(
            parse_retry_after_ms("18446744073709551615"),
            Some(MAX_RETRY_AFTER_MS)
        );
        assert_eq!(parse_retry_after_ms(""), None);
        assert_eq!(parse_retry_after_ms("not-a-delay"), None);
    }

    #[test]
    fn retry_after_http_dates_are_normalized_without_overflow() {
        let past = "Wed, 21 Oct 2015 07:28:00 GMT";
        assert_eq!(parse_retry_after_ms(past), Some(0));

        let future = (Utc::now() + chrono::Duration::seconds(60)).to_rfc2822();
        let parsed = parse_retry_after_ms(&future).expect("future HTTP date should parse");
        assert!(parsed > 0);
        assert!(parsed <= 60_000);

        let far_future = (Utc::now() + chrono::Duration::days(365 * 10)).to_rfc2822();
        assert_eq!(parse_retry_after_ms(&far_future), Some(MAX_RETRY_AFTER_MS));
    }

    #[test]
    fn coalesces_multi_frame_sse_chunk_into_single_emission_batch() {
        let mut decoder = SseDecoder::default();
        let raw_chunk = concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think-1 \"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think-2\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\", \"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"world!\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":3,\"prompt_tokens_details\":{\"cached_tokens\":80}}}\n\n",
            "data: [DONE]\n\n"
        );
        let frames = decoder.push(raw_chunk.as_bytes()).unwrap();
        assert_eq!(frames.len(), 6);

        let mut state = ProviderStreamState::new(ProviderFamily::OpenAi);
        let (batches, frame_error) =
            coalesce_frames_for_chunk(ProviderFamily::OpenAi, &frames, &mut state);
        assert!(frame_error.is_none());
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].text, vec!["Hello, world!"]);
        assert_eq!(batches[0].reasoning, vec!["think-1 think-2"]);
        let usage = batches[0]
            .usage
            .as_ref()
            .expect("merged usage should be present");
        assert_eq!(usage.input_tokens, Some(100));
        assert_eq!(usage.output_tokens, Some(3));
        assert_eq!(usage.cached_input_tokens, Some(80));
        assert_eq!(state.finish_reason().unwrap(), "stop");
    }

    #[test]
    fn coalescer_flushes_preceding_deltas_when_same_chunk_contains_remote_or_protocol_error() {
        let mut decoder = SseDecoder::default();
        let raw_chunk = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Partial \"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"progress\"}}]}\n\n",
            "data: {\"error\":{\"message\":\"upstream overloaded\"}}\n\n"
        );
        let frames = decoder.push(raw_chunk.as_bytes()).unwrap();
        let mut state = ProviderStreamState::new(ProviderFamily::OpenAi);
        let (batches, frame_error) =
            coalesce_frames_for_chunk(ProviderFamily::OpenAi, &frames, &mut state);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].text, vec!["Partial progress"]);
        let error = frame_error.expect("remote error frame must surface after partial batch");
        assert_eq!(error.code, "provider_stream_error");
        assert!(error.message.contains("upstream overloaded"));
    }
}
