#[cfg(test)]
use std::collections::BTreeMap;

use rusqlite::params;
#[cfg(test)]
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

#[cfg(test)]
use crate::{error::ProviderErrorClass, run_journal::RunJournalEventRecord};
use crate::{
    error::{NativeError, NativeResult},
    storage::{now_ms, Storage},
};

pub const TELEMETRY_RECORD_SCHEMA_VERSION: i64 = 1;
const DEFAULT_PROFILE_ID: &str = "profile_default";

const MAX_DIAGNOSTIC_CODE: usize = 160;
const MAX_TELEMETRY_ATTEMPTS_PER_READ: usize = 16;
const MAX_TIMING_OBSERVATIONS_PER_ATTEMPT: usize = 128;
const MAX_USAGE_ENTRIES_PER_ATTEMPT: usize = 128;
const MAX_COST_STATEMENTS_PER_USAGE_ENTRY: usize = 64;
const MAX_TOTAL_TELEMETRY_OBSERVATIONS_PER_READ: usize = 512;
const MAX_RUN_TELEMETRY_SNAPSHOT_BYTES: usize = 512 * 1024;

#[cfg(test)]
/// Normalize a provider health class through the one native taxonomy.  This
/// boundary accepts renderer/IPC text, so arbitrary provider-owned strings must
/// never be persisted as if they were typed classes.
fn canonical_provider_error_class(value: &str) -> NativeResult<&'static str> {
    ProviderErrorClass::parse(value)
        .map(|class| class.as_str())
        .ok_or_else(|| {
            NativeError::invalid(
                "errorClass",
                "must be one of the canonical provider error classes",
            )
        })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimingMarks {
    pub dispatch_started_ms: u64,
    pub request_committed_ms: Option<u64>,
    pub first_byte_ms: Option<u64>,
    pub first_provider_output_ms: Option<u64>,
    pub first_reasoning_ms: Option<u64>,
    pub first_visible_output_ms: Option<u64>,
    pub first_complete_item_ms: Option<u64>,
    pub last_visible_output_ms: Option<u64>,
    pub terminal_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimingWaits {
    pub queue_ms: Option<u64>,
    pub context_compile_ms: Option<u64>,
    pub approval_wait_ms: Option<u64>,
    pub provider_backoff_ms: Option<u64>,
    pub tool_wait_ms: Option<u64>,
    pub renderer_backpressure_ms: Option<u64>,
}

#[cfg(test)]
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageCounters {
    pub input_tokens: Option<u64>,
    pub cache_read_input_tokens: Option<u64>,
    pub cache_write_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub visible_output_tokens: Option<u64>,
}

#[cfg(test)]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CostStatementInput {
    pub kind: String,
    pub component: String,
    pub amount_microunits: u64,
    pub currency: String,
    pub price_snapshot_id: Option<String>,
    pub price_snapshot_hash: Option<String>,
    pub formula_version: Option<String>,
}

#[cfg(test)]
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CostStatementRecord {
    pub schema_version: i64,
    pub id: String,
    pub usage_entry_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub kind: String,
    pub component: String,
    pub amount_microunits: u64,
    pub currency: String,
    pub price_snapshot_id: Option<String>,
    pub price_snapshot_hash: Option<String>,
    pub formula_version: Option<String>,
    pub observed_at_ms: i64,
    pub created_at_ms: i64,
}

#[cfg(test)]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLedgerEntryRecord {
    pub schema_version: i64,
    pub id: String,
    pub profile_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub sequence: i64,
    pub source: String,
    pub authoritative: bool,
    pub coverage: String,
    pub observed_at_ms: i64,
    pub response_identity_hash: Option<String>,
    pub counters: UsageCounters,
    pub provider_counters: BTreeMap<String, u64>,
    pub costs: Vec<CostStatementRecord>,
    pub supersedes_entry_id: Option<String>,
    pub created_at_ms: i64,
    pub journal_event: Option<RunJournalEventRecord>,
}

#[cfg(test)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderQuotaWindowInput {
    pub kind: String,
    pub limit: Option<u64>,
    pub remaining: Option<u64>,
    pub reset_at_ms: Option<i64>,
    pub window_seconds: Option<u64>,
    pub source: String,
    pub authoritative: bool,
}

/// A read-only, content-free request for one exact run's native telemetry.
/// The optional attempt selector narrows the response; it never changes the
/// run's durable accounting history.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadRunTelemetryRequest {
    pub run_id: String,
    pub attempt_id: Option<String>,
}

/// Renderer-safe projection of one provider attempt. Raw prompts, responses,
/// reasoning text, remote request IDs, credentials, paths, and tool payloads
/// are deliberately absent from this DTO.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTelemetryAttemptSnapshot {
    pub attempt_id: String,
    pub ordinal: i64,
    pub provider_profile_id: Option<String>,
    pub model_id: String,
    pub state: String,
    pub accepted_by_provider: String,
    pub error_code: Option<String>,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub created_at_ms: i64,
    pub timing_observations: Vec<RendererTimingObservation>,
    pub usage_ledger: Vec<RendererUsageObservation>,
}

/// Content-free timing fields exposed to the renderer. Scope, clock domain,
/// correlation identity and storage metadata remain native-only because the
/// attempt snapshot already supplies the necessary lineage.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererTimingObservation {
    pub observed_at_ms: i64,
    pub coverage: String,
    pub marks: TimingMarks,
    pub waits: TimingWaits,
}

/// Numeric normalized usage counters deliberately separated from the storage
/// record. Adding a field to the durable ledger cannot silently widen the IPC
/// payload without an explicit renderer DTO change and review.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererUsageCounters {
    pub input_tokens: Option<u64>,
    pub cache_read_input_tokens: Option<u64>,
    pub cache_write_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub visible_output_tokens: Option<u64>,
}

/// One immutable usage observation suitable for the request inspector. It
/// intentionally omits profile IDs, remote identity hashes, provider counter
/// names, price/formula metadata, supersession IDs, and journal payloads.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererUsageObservation {
    pub sequence: i64,
    pub source: String,
    pub authoritative: bool,
    pub coverage: String,
    pub observed_at_ms: i64,
    pub counters: RendererUsageCounters,
    pub cost_statement_count: u32,
}

/// Content-free native telemetry for a run. The response intentionally keeps
/// raw observations separate instead of fabricating a single final total.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTelemetrySnapshot {
    pub schema_version: i64,
    pub run_id: String,
    pub attempts: Vec<RunTelemetryAttemptSnapshot>,
    pub read_at_ms: i64,
}

fn validate_id(field: &'static str, value: &str, prefix: &str) -> NativeResult<()> {
    let suffix = value.strip_prefix(prefix).ok_or_else(|| {
        NativeError::invalid(field, "does not use the expected opaque identifier prefix")
    })?;
    if suffix.len() != 32 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(NativeError::invalid(field, "is malformed"));
    }
    Ok(())
}

#[cfg(test)]
fn validate_non_blank(field: &'static str, value: &str, max_bytes: usize) -> NativeResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(NativeError::invalid(
            field,
            "must be non-empty, bounded text",
        ));
    }
    Ok(value.to_owned())
}

fn validate_coverage(value: &str) -> NativeResult<&'static str> {
    match value {
        "complete" | "partial" | "estimated" | "unknown" => Ok(match value {
            "complete" => "complete",
            "partial" => "partial",
            "estimated" => "estimated",
            _ => "unknown",
        }),
        _ => Err(NativeError::invalid(
            "coverage",
            "is not a supported telemetry coverage",
        )),
    }
}

#[cfg(test)]
fn to_i64(field: &'static str, value: u64) -> NativeResult<i64> {
    i64::try_from(value).map_err(|_| NativeError::invalid(field, "exceeds SQLite integer range"))
}

#[cfg(test)]
fn optional_i64(field: &'static str, value: Option<u64>) -> NativeResult<Option<i64>> {
    value.map(|value| to_i64(field, value)).transpose()
}

#[cfg(test)]
fn validate_hash(field: &'static str, value: &str) -> NativeResult<String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(NativeError::invalid(field, "must be a SHA-256 hex digest"));
    }
    Ok(value.to_ascii_lowercase())
}

#[cfg(test)]
fn validate_provider_counter_key(key: &str) -> bool {
    let mut parts = key.split('.');
    let Some(namespace) = parts.next() else {
        return false;
    };
    let Some(name) = parts.next() else {
        return false;
    };
    if parts.next().is_some()
        || namespace.is_empty()
        || name.is_empty()
        || !namespace.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
        || !name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
    {
        return false;
    }
    true
}

#[cfg(test)]
fn validate_currency(value: &str) -> NativeResult<String> {
    let currency = value.trim().to_ascii_uppercase();
    if !(3..=8).contains(&currency.len())
        || !currency
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return Err(NativeError::invalid(
            "currency",
            "must be an uppercase currency code",
        ));
    }
    Ok(currency)
}

#[cfg(test)]
fn validate_cost(input: &CostStatementInput) -> NativeResult<CostStatementInput> {
    let kind = match input.kind.as_str() {
        "calculated-estimate" | "provider-reported" | "invoice" | "user-override" => {
            input.kind.clone()
        }
        _ => return Err(NativeError::invalid("cost.kind", "is not supported")),
    };
    let component = validate_non_blank("cost.component", &input.component, 160)?;
    let currency = validate_currency(&input.currency)?;
    let price_snapshot_id = input
        .price_snapshot_id
        .as_deref()
        .map(|value| validate_non_blank("cost.priceSnapshotId", value, 256))
        .transpose()?;
    let price_snapshot_hash = input
        .price_snapshot_hash
        .as_deref()
        .map(|value| validate_hash("cost.priceSnapshotHash", value))
        .transpose()?;
    let formula_version = input
        .formula_version
        .as_deref()
        .map(|value| validate_non_blank("cost.formulaVersion", value, 120))
        .transpose()?;
    if kind == "calculated-estimate"
        && (price_snapshot_id.is_none()
            || price_snapshot_hash.is_none()
            || formula_version.is_none())
    {
        return Err(NativeError::invalid(
            "cost",
            "calculated estimates require a price snapshot and formula version",
        ));
    }
    Ok(CostStatementInput {
        kind,
        component,
        amount_microunits: input.amount_microunits,
        currency,
        price_snapshot_id,
        price_snapshot_hash,
        formula_version,
    })
}

#[cfg(test)]
fn validate_marks(marks: &TimingMarks) -> NativeResult<[Option<i64>; 9]> {
    let values = [
        Some(to_i64("dispatchStartedMs", marks.dispatch_started_ms)?),
        optional_i64("requestCommittedMs", marks.request_committed_ms)?,
        optional_i64("firstByteMs", marks.first_byte_ms)?,
        optional_i64("firstProviderOutputMs", marks.first_provider_output_ms)?,
        optional_i64("firstReasoningMs", marks.first_reasoning_ms)?,
        optional_i64("firstVisibleOutputMs", marks.first_visible_output_ms)?,
        optional_i64("firstCompleteItemMs", marks.first_complete_item_ms)?,
        optional_i64("lastVisibleOutputMs", marks.last_visible_output_ms)?,
        optional_i64("terminalMs", marks.terminal_ms)?,
    ];
    let ordered = |later: Option<i64>, earlier: Option<i64>, label: &'static str| {
        if let (Some(later), Some(earlier)) = (later, earlier) {
            if later < earlier {
                return Err(NativeError::invalid(
                    label,
                    "cannot occur before its prerequisite milestone",
                ));
            }
        }
        Ok(())
    };
    ordered(values[1], values[0], "requestCommittedMs")?;
    ordered(values[2], values[1].or(values[0]), "firstByteMs")?;
    ordered(values[3], values[2].or(values[0]), "firstProviderOutputMs")?;
    ordered(values[4], values[2].or(values[0]), "firstReasoningMs")?;
    ordered(values[5], values[2].or(values[0]), "firstVisibleOutputMs")?;
    ordered(values[6], values[2].or(values[0]), "firstCompleteItemMs")?;
    ordered(values[7], values[5].or(values[0]), "lastVisibleOutputMs")?;
    for mark in values.iter().take(8).flatten() {
        ordered(values[8], Some(*mark), "terminalMs")?;
    }
    Ok(values)
}

#[derive(Debug)]
struct RawRendererTimingObservation {
    observed_at_ms: i64,
    coverage: String,
    dispatch_started_ms: i64,
    request_committed_ms: Option<i64>,
    first_byte_ms: Option<i64>,
    first_provider_output_ms: Option<i64>,
    first_reasoning_ms: Option<i64>,
    first_visible_output_ms: Option<i64>,
    first_complete_item_ms: Option<i64>,
    last_visible_output_ms: Option<i64>,
    terminal_ms: Option<i64>,
    queue_ms: Option<i64>,
    context_compile_ms: Option<i64>,
    approval_wait_ms: Option<i64>,
    provider_backoff_ms: Option<i64>,
    tool_wait_ms: Option<i64>,
    renderer_backpressure_ms: Option<i64>,
}

#[derive(Debug)]
struct RawRendererUsageObservation {
    sequence: i64,
    source: String,
    authoritative: i64,
    coverage: String,
    observed_at_ms: i64,
    input_tokens: Option<i64>,
    cache_read_input_tokens: Option<i64>,
    cache_write_input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    reasoning_tokens: Option<i64>,
    visible_output_tokens: Option<i64>,
    cost_statement_count: i64,
}

fn telemetry_scope_denied() -> NativeError {
    // Do not reveal whether a run exists under another profile. The same
    // redacted result is used for a missing run and an attempt/run mismatch.
    NativeError::new(
        "telemetry_scope_denied",
        "The requested telemetry is unavailable to the active profile",
    )
}

fn telemetry_integrity_error() -> NativeError {
    NativeError::new(
        "telemetry_integrity_failed",
        "The stored telemetry does not satisfy the renderer safety contract",
    )
}

fn telemetry_read_limit_error(collection: &str, limit: usize) -> NativeError {
    NativeError::new(
        "telemetry_read_limit_exceeded",
        format!(
            "The requested telemetry exceeds the {limit}-record {collection} read limit; pagination is required",
        ),
    )
}

fn telemetry_query_limit(maximum: usize) -> NativeResult<i64> {
    i64::try_from(maximum.saturating_add(1)).map_err(|_| {
        NativeError::new(
            "telemetry_read_limit_invalid",
            "The telemetry read limit could not be represented safely",
        )
    })
}

fn positive_timestamp_from_db(value: i64) -> NativeResult<i64> {
    if value > 0 {
        Ok(value)
    } else {
        Err(telemetry_integrity_error())
    }
}

fn counter_from_db(value: i64) -> NativeResult<u64> {
    u64::try_from(value).map_err(|_| telemetry_integrity_error())
}

fn optional_counter_from_db(value: Option<i64>) -> NativeResult<Option<u64>> {
    value.map(counter_from_db).transpose()
}

fn safe_model_id_from_db(value: &str) -> NativeResult<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 160
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/')
        })
    {
        return Err(telemetry_integrity_error());
    }
    Ok(value.to_owned())
}

fn safe_attempt_state_from_db(value: &str) -> NativeResult<String> {
    match value {
        "created" | "dispatching" | "accepted" | "streaming" | "complete" | "interrupted"
        | "failed" | "outcome_unknown" => Ok(value.to_owned()),
        _ => Err(telemetry_integrity_error()),
    }
}

fn safe_acceptance_from_db(value: &str) -> NativeResult<String> {
    match value {
        "false" | "true" | "unknown" => Ok(value.to_owned()),
        _ => Err(telemetry_integrity_error()),
    }
}

fn safe_error_code_from_db(value: Option<String>) -> Option<String> {
    value.map(|value| {
        let value = value.trim();
        if !value.is_empty()
            && value.len() <= MAX_DIAGNOSTIC_CODE
            && value.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'_' | b'-' | b'.')
            })
        {
            value.to_owned()
        } else {
            "telemetry_corrupt_error_code".to_owned()
        }
    })
}

fn renderer_timing_from_raw(
    raw: RawRendererTimingObservation,
) -> NativeResult<RendererTimingObservation> {
    Ok(RendererTimingObservation {
        observed_at_ms: positive_timestamp_from_db(raw.observed_at_ms)?,
        coverage: validate_coverage(&raw.coverage)?.to_owned(),
        marks: TimingMarks {
            dispatch_started_ms: counter_from_db(raw.dispatch_started_ms)?,
            request_committed_ms: optional_counter_from_db(raw.request_committed_ms)?,
            first_byte_ms: optional_counter_from_db(raw.first_byte_ms)?,
            first_provider_output_ms: optional_counter_from_db(raw.first_provider_output_ms)?,
            first_reasoning_ms: optional_counter_from_db(raw.first_reasoning_ms)?,
            first_visible_output_ms: optional_counter_from_db(raw.first_visible_output_ms)?,
            first_complete_item_ms: optional_counter_from_db(raw.first_complete_item_ms)?,
            last_visible_output_ms: optional_counter_from_db(raw.last_visible_output_ms)?,
            terminal_ms: optional_counter_from_db(raw.terminal_ms)?,
        },
        waits: TimingWaits {
            queue_ms: optional_counter_from_db(raw.queue_ms)?,
            context_compile_ms: optional_counter_from_db(raw.context_compile_ms)?,
            approval_wait_ms: optional_counter_from_db(raw.approval_wait_ms)?,
            provider_backoff_ms: optional_counter_from_db(raw.provider_backoff_ms)?,
            tool_wait_ms: optional_counter_from_db(raw.tool_wait_ms)?,
            renderer_backpressure_ms: optional_counter_from_db(raw.renderer_backpressure_ms)?,
        },
    })
}

fn renderer_usage_from_raw(
    raw: RawRendererUsageObservation,
) -> NativeResult<RendererUsageObservation> {
    let source = match raw.source.as_str() {
        "local-estimate"
        | "provider-incremental"
        | "provider-final"
        | "provider-invoice"
        | "user-correction" => raw.source,
        _ => return Err(telemetry_integrity_error()),
    };
    if raw.sequence < 1 || !matches!(raw.authoritative, 0 | 1) {
        return Err(telemetry_integrity_error());
    }
    let cost_statement_count =
        u32::try_from(raw.cost_statement_count).map_err(|_| telemetry_integrity_error())?;
    if cost_statement_count as usize > MAX_COST_STATEMENTS_PER_USAGE_ENTRY {
        return Err(telemetry_read_limit_error(
            "cost statements per usage observation",
            MAX_COST_STATEMENTS_PER_USAGE_ENTRY,
        ));
    }
    Ok(RendererUsageObservation {
        sequence: raw.sequence,
        source,
        authoritative: raw.authoritative == 1,
        coverage: validate_coverage(&raw.coverage)?.to_owned(),
        observed_at_ms: positive_timestamp_from_db(raw.observed_at_ms)?,
        counters: RendererUsageCounters {
            input_tokens: optional_counter_from_db(raw.input_tokens)?,
            cache_read_input_tokens: optional_counter_from_db(raw.cache_read_input_tokens)?,
            cache_write_input_tokens: optional_counter_from_db(raw.cache_write_input_tokens)?,
            output_tokens: optional_counter_from_db(raw.output_tokens)?,
            reasoning_tokens: optional_counter_from_db(raw.reasoning_tokens)?,
            visible_output_tokens: optional_counter_from_db(raw.visible_output_tokens)?,
        },
        cost_statement_count,
    })
}

fn validate_owned_run_telemetry_scope(
    connection: &rusqlite::Connection,
    run_id: &str,
) -> NativeResult<()> {
    let owned: bool = connection.query_row(
        "SELECT EXISTS(
             SELECT 1
             FROM generations run
             JOIN conversations conversation ON conversation.id = run.conversation_id
             WHERE run.id = ?1
               AND conversation.profile_id = ?2
               AND conversation.deleted_at_ms IS NULL
         )",
        params![run_id, DEFAULT_PROFILE_ID],
        |row| row.get(0),
    )?;
    if owned {
        Ok(())
    } else {
        Err(telemetry_scope_denied())
    }
}

fn validate_run_attempt_telemetry_scope(
    connection: &rusqlite::Connection,
    run_id: &str,
    attempt_id: &str,
) -> NativeResult<()> {
    let owned: bool = connection.query_row(
        "SELECT EXISTS(
             SELECT 1
             FROM run_attempts attempt
             JOIN generations run ON run.id = attempt.generation_id
             JOIN conversations conversation ON conversation.id = run.conversation_id
             WHERE run.id = ?1
               AND attempt.id = ?2
               AND conversation.profile_id = ?3
               AND conversation.deleted_at_ms IS NULL
         )",
        params![run_id, attempt_id, DEFAULT_PROFILE_ID],
        |row| row.get(0),
    )?;
    if owned {
        Ok(())
    } else {
        Err(telemetry_scope_denied())
    }
}

fn validate_telemetry_observation_lineage(
    connection: &rusqlite::Connection,
    run_id: &str,
    attempt_id: &str,
) -> NativeResult<()> {
    let timing_mismatch: bool = connection.query_row(
        "SELECT EXISTS(
             SELECT 1
             FROM run_timing_observations
             WHERE attempt_id = ?1
               AND (run_id <> ?2 OR profile_id <> ?3)
         )",
        params![attempt_id, run_id, DEFAULT_PROFILE_ID],
        |row| row.get(0),
    )?;
    let usage_mismatch: bool = connection.query_row(
        "SELECT EXISTS(
             SELECT 1
             FROM run_usage_ledger
             WHERE attempt_id = ?1
               AND (run_id <> ?2 OR profile_id <> ?3)
         )",
        params![attempt_id, run_id, DEFAULT_PROFILE_ID],
        |row| row.get(0),
    )?;
    if timing_mismatch || usage_mismatch {
        Err(telemetry_integrity_error())
    } else {
        Ok(())
    }
}

fn load_bounded_timing_observations(
    connection: &rusqlite::Connection,
    run_id: &str,
    attempt_id: &str,
) -> NativeResult<Vec<RendererTimingObservation>> {
    let query_limit = telemetry_query_limit(MAX_TIMING_OBSERVATIONS_PER_ATTEMPT)?;
    let raw_observations = {
        let mut statement = connection.prepare(
            "SELECT observed_at_ms, coverage,
                    dispatch_started_ms, request_committed_ms, first_byte_ms,
                    first_provider_output_ms, first_reasoning_ms, first_visible_output_ms,
                    first_complete_item_ms, last_visible_output_ms, terminal_ms,
                    queue_ms, context_compile_ms, approval_wait_ms, provider_backoff_ms,
                    tool_wait_ms, renderer_backpressure_ms
             FROM run_timing_observations INDEXED BY run_timing_observations_attempt_idx
             WHERE profile_id = ?1 AND run_id = ?2 AND attempt_id = ?3
             ORDER BY observed_at_ms ASC, id ASC
             LIMIT ?4",
        )?;
        let rows = statement.query_map(
            params![DEFAULT_PROFILE_ID, run_id, attempt_id, query_limit],
            |row| {
                Ok(RawRendererTimingObservation {
                    observed_at_ms: row.get(0)?,
                    coverage: row.get(1)?,
                    dispatch_started_ms: row.get(2)?,
                    request_committed_ms: row.get(3)?,
                    first_byte_ms: row.get(4)?,
                    first_provider_output_ms: row.get(5)?,
                    first_reasoning_ms: row.get(6)?,
                    first_visible_output_ms: row.get(7)?,
                    first_complete_item_ms: row.get(8)?,
                    last_visible_output_ms: row.get(9)?,
                    terminal_ms: row.get(10)?,
                    queue_ms: row.get(11)?,
                    context_compile_ms: row.get(12)?,
                    approval_wait_ms: row.get(13)?,
                    provider_backoff_ms: row.get(14)?,
                    tool_wait_ms: row.get(15)?,
                    renderer_backpressure_ms: row.get(16)?,
                })
            },
        )?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if raw_observations.len() > MAX_TIMING_OBSERVATIONS_PER_ATTEMPT {
        return Err(telemetry_read_limit_error(
            "timing observations per attempt",
            MAX_TIMING_OBSERVATIONS_PER_ATTEMPT,
        ));
    }
    raw_observations
        .into_iter()
        .map(renderer_timing_from_raw)
        .collect()
}

pub(crate) fn load_bounded_usage_ledger(
    connection: &rusqlite::Connection,
    run_id: &str,
    attempt_id: &str,
) -> NativeResult<Vec<RendererUsageObservation>> {
    let query_limit = telemetry_query_limit(MAX_USAGE_ENTRIES_PER_ATTEMPT)?;
    let raw_observations = {
        let mut statement = connection.prepare(
            "SELECT ledger.sequence_no, ledger.source, ledger.authoritative,
                    ledger.coverage, ledger.observed_at_ms, ledger.input_tokens,
                    ledger.cache_read_input_tokens, ledger.cache_write_input_tokens,
                    ledger.output_tokens, ledger.reasoning_tokens,
                    ledger.visible_output_tokens,
                    (SELECT COUNT(*) FROM run_cost_statements cost
                     WHERE cost.usage_entry_id = ledger.id) AS cost_statement_count
             FROM run_usage_ledger ledger
             WHERE ledger.profile_id = ?1
               AND ledger.run_id = ?2
               AND ledger.attempt_id = ?3
             ORDER BY ledger.sequence_no ASC, ledger.id ASC
             LIMIT ?4",
        )?;
        let rows = statement.query_map(
            params![DEFAULT_PROFILE_ID, run_id, attempt_id, query_limit],
            |row| {
                Ok(RawRendererUsageObservation {
                    sequence: row.get(0)?,
                    source: row.get(1)?,
                    authoritative: row.get(2)?,
                    coverage: row.get(3)?,
                    observed_at_ms: row.get(4)?,
                    input_tokens: row.get(5)?,
                    cache_read_input_tokens: row.get(6)?,
                    cache_write_input_tokens: row.get(7)?,
                    output_tokens: row.get(8)?,
                    reasoning_tokens: row.get(9)?,
                    visible_output_tokens: row.get(10)?,
                    cost_statement_count: row.get(11)?,
                })
            },
        )?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if raw_observations.len() > MAX_USAGE_ENTRIES_PER_ATTEMPT {
        return Err(telemetry_read_limit_error(
            "usage observations per attempt",
            MAX_USAGE_ENTRIES_PER_ATTEMPT,
        ));
    }
    raw_observations
        .into_iter()
        .map(renderer_usage_from_raw)
        .collect()
}

impl Storage {
    #[cfg(test)]
    pub fn list_usage_ledger(
        &self,
        run_id: &str,
        attempt_id: Option<&str>,
    ) -> NativeResult<Vec<UsageLedgerEntryRecord>> {
        validate_id("runId", run_id, "run_")?;
        if let Some(attempt_id) = attempt_id {
            validate_id("attemptId", attempt_id, "attempt_")?;
        }
        self.with_connection(|connection| {
            let ids = if let Some(attempt_id) = attempt_id {
                let mut statement = connection.prepare(
                    "SELECT id FROM run_usage_ledger
                     WHERE run_id = ?1 AND attempt_id = ?2
                     ORDER BY sequence_no, id",
                )?;
                let rows = statement
                    .query_map(params![run_id, attempt_id], |row| row.get::<_, String>(0))?;
                rows.collect::<Result<Vec<_>, _>>()?
            } else {
                let mut statement = connection.prepare(
                    "SELECT id FROM run_usage_ledger
                     WHERE run_id = ?1
                     ORDER BY sequence_no, id",
                )?;
                let rows = statement.query_map([run_id], |row| row.get::<_, String>(0))?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            ids.iter()
                .map(|id| load_usage_entry_connection(connection, id))
                .collect()
        })
    }

    /// Reads renderer-safe, attempt-scoped telemetry for one run. This is a
    /// bounded projection over immutable local observations. It deliberately
    /// returns only the explicitly allowlisted renderer DTO fields rather than
    /// fabricating a final token total, duration, quota window, or cost
    /// reconciliation.
    pub fn read_run_telemetry(
        &self,
        request: &ReadRunTelemetryRequest,
    ) -> NativeResult<RunTelemetrySnapshot> {
        validate_id("runId", &request.run_id, "run_")?;
        if let Some(attempt_id) = request.attempt_id.as_deref() {
            validate_id("attemptId", attempt_id, "attempt_")?;
        }

        self.with_connection(|connection| {
            validate_owned_run_telemetry_scope(connection, &request.run_id)?;
            if let Some(attempt_id) = request.attempt_id.as_deref() {
                validate_run_attempt_telemetry_scope(connection, &request.run_id, attempt_id)?;
            }

            let read_limit = telemetry_query_limit(MAX_TELEMETRY_ATTEMPTS_PER_READ)?;
            let mut statement = connection.prepare(
                "SELECT id, ordinal, provider_profile_id, model_id, state,
                        accepted_by_provider, error_code, started_at_ms,
                        completed_at_ms, created_at_ms
                 FROM run_attempts
                 WHERE generation_id = ?1 AND (?2 IS NULL OR id = ?2)
                 ORDER BY ordinal ASC, id ASC
                 LIMIT ?3",
            )?;
            let selected_attempts = statement
                .query_map(
                    params![request.run_id, request.attempt_id.as_deref(), read_limit],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, Option<String>>(6)?,
                            row.get::<_, Option<i64>>(7)?,
                            row.get::<_, Option<i64>>(8)?,
                            row.get::<_, i64>(9)?,
                        ))
                    },
                )?
                .collect::<Result<Vec<_>, _>>()?;
            if selected_attempts.len() > MAX_TELEMETRY_ATTEMPTS_PER_READ {
                return Err(telemetry_read_limit_error(
                    "attempts",
                    MAX_TELEMETRY_ATTEMPTS_PER_READ,
                ));
            }

            let mut attempts = Vec::with_capacity(selected_attempts.len());
            let mut observation_count = 0usize;
            for (
                attempt_id,
                ordinal,
                provider_profile_id,
                model_id,
                state,
                accepted_by_provider,
                error_code,
                started_at_ms,
                completed_at_ms,
                created_at_ms,
            ) in selected_attempts
            {
                validate_id("attemptId", &attempt_id, "attempt_")
                    .map_err(|_| telemetry_integrity_error())?;
                let provider_profile_id = provider_profile_id
                    .map(|value| {
                        validate_id("providerProfileId", &value, "provider_")
                            .map_err(|_| telemetry_integrity_error())?;
                        Ok::<String, NativeError>(value)
                    })
                    .transpose()?;
                let timing_observations =
                    load_bounded_timing_observations(connection, &request.run_id, &attempt_id)?;
                let usage_ledger =
                    load_bounded_usage_ledger(connection, &request.run_id, &attempt_id)?;
                validate_telemetry_observation_lineage(connection, &request.run_id, &attempt_id)?;
                observation_count = observation_count
                    .checked_add(timing_observations.len())
                    .and_then(|count| count.checked_add(usage_ledger.len()))
                    .ok_or_else(telemetry_integrity_error)?;
                if observation_count > MAX_TOTAL_TELEMETRY_OBSERVATIONS_PER_READ {
                    return Err(telemetry_read_limit_error(
                        "total observations",
                        MAX_TOTAL_TELEMETRY_OBSERVATIONS_PER_READ,
                    ));
                }
                attempts.push(RunTelemetryAttemptSnapshot {
                    timing_observations,
                    usage_ledger,
                    attempt_id,
                    ordinal,
                    provider_profile_id,
                    model_id: safe_model_id_from_db(&model_id)?,
                    state: safe_attempt_state_from_db(&state)?,
                    accepted_by_provider: safe_acceptance_from_db(&accepted_by_provider)?,
                    error_code: safe_error_code_from_db(error_code),
                    started_at_ms: started_at_ms.map(positive_timestamp_from_db).transpose()?,
                    completed_at_ms: completed_at_ms
                        .map(positive_timestamp_from_db)
                        .transpose()?,
                    created_at_ms: positive_timestamp_from_db(created_at_ms)?,
                });
            }

            let snapshot = RunTelemetrySnapshot {
                schema_version: TELEMETRY_RECORD_SCHEMA_VERSION,
                run_id: request.run_id.clone(),
                attempts,
                read_at_ms: now_ms(),
            };
            let serialized = serde_json::to_vec(&snapshot).map_err(|_| {
                NativeError::new(
                    "telemetry_serialization_failed",
                    "The telemetry snapshot could not be serialized safely",
                )
            })?;
            if serialized.len() > MAX_RUN_TELEMETRY_SNAPSHOT_BYTES {
                return Err(telemetry_read_limit_error(
                    "serialized telemetry snapshot bytes",
                    MAX_RUN_TELEMETRY_SNAPSHOT_BYTES,
                ));
            }
            Ok(snapshot)
        })
    }
}

#[cfg(test)]
fn validate_quota(input: ProviderQuotaWindowInput) -> NativeResult<ProviderQuotaWindowInput> {
    let kind = match input.kind.as_str() {
        "requests" | "input-tokens" | "output-tokens" | "total-tokens" | "concurrency" => {
            input.kind
        }
        _ => return Err(NativeError::invalid("quota.kind", "is not supported")),
    };
    let source = match input.source.as_str() {
        "provider-header" | "provider-api" | "configured" | "inferred" => input.source,
        _ => return Err(NativeError::invalid("quota.source", "is not supported")),
    };
    if source == "inferred" && input.authoritative {
        return Err(NativeError::invalid(
            "quota.authoritative",
            "inferred quota cannot be authoritative",
        ));
    }
    if let (Some(limit), Some(remaining)) = (input.limit, input.remaining) {
        if remaining > limit {
            return Err(NativeError::invalid(
                "quota.remaining",
                "cannot exceed the quota limit",
            ));
        }
    }
    if input.reset_at_ms.is_some_and(|value| value <= 0) {
        return Err(NativeError::invalid(
            "quota.resetAtMs",
            "must be positive when present",
        ));
    }
    Ok(ProviderQuotaWindowInput {
        kind,
        limit: input.limit,
        remaining: input.remaining,
        reset_at_ms: input.reset_at_ms,
        window_seconds: input.window_seconds,
        source,
        authoritative: input.authoritative,
    })
}

#[cfg(test)]
fn load_usage_entry_connection(
    connection: &rusqlite::Connection,
    id: &str,
) -> NativeResult<UsageLedgerEntryRecord> {
    let row = connection
        .query_row(
            "SELECT id, schema_version, profile_id, run_id, attempt_id,
                    sequence_no, source, authoritative, coverage, observed_at_ms,
                    response_identity_hash, supersedes_entry_id, created_at_ms,
                    input_tokens, cache_read_input_tokens, cache_write_input_tokens,
                    output_tokens, reasoning_tokens, visible_output_tokens,
                    provider_counters_json
             FROM run_usage_ledger
             WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)? != 0,
                    row.get::<_, String>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, Option<i64>>(13)?,
                    row.get::<_, Option<i64>>(14)?,
                    row.get::<_, Option<i64>>(15)?,
                    row.get::<_, Option<i64>>(16)?,
                    row.get::<_, Option<i64>>(17)?,
                    row.get::<_, Option<i64>>(18)?,
                    row.get::<_, String>(19)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| {
            NativeError::new(
                "telemetry_not_found",
                "The usage ledger entry was not found",
            )
        })?;
    let provider_counters =
        serde_json::from_str::<BTreeMap<String, u64>>(&row.19).map_err(|_| {
            NativeError::new(
                "telemetry_serialization_failed",
                "The provider counter payload is invalid",
            )
        })?;
    let mut costs = Vec::new();
    let mut statement = connection.prepare(
        "SELECT id, schema_version, usage_entry_id, run_id, attempt_id,
                kind, component, amount_microunits, currency,
                price_snapshot_id, price_snapshot_hash, formula_version,
                observed_at_ms, created_at_ms
         FROM run_cost_statements
         WHERE usage_entry_id = ?1
         ORDER BY id",
    )?;
    let rows = statement.query_map([id], |cost| {
        Ok(CostStatementRecord {
            schema_version: cost.get(1)?,
            id: cost.get(0)?,
            usage_entry_id: cost.get(2)?,
            run_id: cost.get(3)?,
            attempt_id: cost.get(4)?,
            kind: cost.get(5)?,
            component: cost.get(6)?,
            amount_microunits: cost.get::<_, i64>(7)? as u64,
            currency: cost.get(8)?,
            price_snapshot_id: cost.get(9)?,
            price_snapshot_hash: cost.get(10)?,
            formula_version: cost.get(11)?,
            observed_at_ms: cost.get(12)?,
            created_at_ms: cost.get(13)?,
        })
    })?;
    for cost in rows {
        costs.push(cost?);
    }
    Ok(UsageLedgerEntryRecord {
        schema_version: row.1,
        id: row.0,
        profile_id: row.2,
        run_id: row.3,
        attempt_id: row.4,
        sequence: row.5,
        source: row.6,
        authoritative: row.7,
        coverage: row.8,
        observed_at_ms: row.9,
        response_identity_hash: row.10,
        counters: UsageCounters {
            input_tokens: row.13.map(|value| value as u64),
            cache_read_input_tokens: row.14.map(|value| value as u64),
            cache_write_input_tokens: row.15.map(|value| value as u64),
            output_tokens: row.16.map(|value| value as u64),
            reasoning_tokens: row.17.map(|value| value as u64),
            visible_output_tokens: row.18.map(|value| value as u64),
        },
        provider_counters,
        costs,
        supersedes_entry_id: row.11,
        created_at_ms: row.12,
        journal_event: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marks() -> TimingMarks {
        TimingMarks {
            dispatch_started_ms: 0,
            request_committed_ms: Some(10),
            first_byte_ms: Some(20),
            first_provider_output_ms: Some(30),
            first_reasoning_ms: Some(35),
            first_visible_output_ms: Some(40),
            first_complete_item_ms: Some(80),
            last_visible_output_ms: Some(120),
            terminal_ms: Some(140),
        }
    }

    #[test]
    fn timing_milestones_are_monotonic() {
        assert!(validate_marks(&marks()).is_ok());

        let mut invalid = marks();
        invalid.first_visible_output_ms = Some(15);
        let error = validate_marks(&invalid).expect_err("visible output cannot precede first byte");
        assert_eq!(error.code, "invalid_input");

        let mut terminal_before_output = marks();
        terminal_before_output.terminal_ms = Some(25);
        let error = validate_marks(&terminal_before_output)
            .expect_err("terminal cannot precede provider output milestones");
        assert_eq!(error.code, "invalid_input");
    }

    #[test]
    fn estimated_cost_requires_frozen_price_provenance() {
        let error = validate_cost(&CostStatementInput {
            kind: "calculated-estimate".into(),
            component: "output".into(),
            amount_microunits: 12,
            currency: "USD".into(),
            price_snapshot_id: None,
            price_snapshot_hash: None,
            formula_version: None,
        })
        .expect_err("an estimate without a price snapshot must be denied");
        assert_eq!(error.code, "invalid_input");
    }

    #[test]
    fn quota_source_and_headroom_rules_are_explicit() {
        let inferred_authoritative = validate_quota(ProviderQuotaWindowInput {
            kind: "requests".into(),
            limit: Some(10),
            remaining: Some(5),
            reset_at_ms: Some(1_000),
            window_seconds: Some(60),
            source: "inferred".into(),
            authoritative: true,
        })
        .expect_err("inferred quota cannot be authoritative");
        assert_eq!(inferred_authoritative.code, "invalid_input");

        let invalid_headroom = validate_quota(ProviderQuotaWindowInput {
            kind: "requests".into(),
            limit: Some(10),
            remaining: Some(11),
            reset_at_ms: None,
            window_seconds: None,
            source: "provider-header".into(),
            authoritative: true,
        })
        .expect_err("remaining quota cannot exceed its limit");
        assert_eq!(invalid_headroom.code, "invalid_input");
    }

    #[test]
    fn provider_counter_keys_are_qualified_and_bounded() {
        assert!(validate_provider_counter_key(
            "anthropic.cache_creation_input_tokens"
        ));
        assert!(validate_provider_counter_key("openai.cached_tokens"));
        assert!(!validate_provider_counter_key("cached_tokens"));
        assert!(!validate_provider_counter_key("OpenAI.cached_tokens"));
        assert!(!validate_provider_counter_key("openai.cache.tokens"));
    }

    #[test]
    fn telemetry_hash_validation_is_strict() {
        let valid = "a".repeat(64);
        assert_eq!(validate_hash("fact", &valid).unwrap(), valid);
        assert!(validate_hash("fact", "not-a-hash").is_err());
    }

    #[test]
    fn provider_health_classes_are_canonicalized_and_arbitrary_text_is_rejected() {
        assert_eq!(
            canonical_provider_error_class("rate-limit").unwrap(),
            "rate-limit"
        );
        let error = canonical_provider_error_class("provider-specific-upstream-code")
            .expect_err("provider-owned text must not enter the taxonomy");
        assert_eq!(error.code, "invalid_input");
    }
}
