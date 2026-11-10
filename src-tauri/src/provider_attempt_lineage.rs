//! Immutable, content-free provenance for one prepared provider attempt.
//!
//! This module is deliberately independent from SQLite.  Storage owns the
//! transaction and foreign-key scope checks; this module owns the typed
//! canonical material, integrity hash, safe projection, and cross-object
//! assertions.  Keeping the hash material here prevents persistence and
//! dispatch validation from silently evolving different preimages.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    error::{NativeError, NativeResult},
    prepared_provider_input::{FrozenProviderInput, StartPreparedAttemptRequest},
    provider_definition::{FrozenProviderDefinition, FROZEN_PROVIDER_DEFINITION_SCHEMA_VERSION},
};

pub const PROVIDER_ATTEMPT_LINEAGE_SCHEMA_VERSION: u32 = 1;
pub const PROVIDER_ATTEMPT_LINEAGE_PREFIX: &str = "provider_lineage_";

const ENDPOINT_FINGERPRINT_DOMAIN: &[u8] = b"omnia-provider-endpoint-v1\0";
const MAX_ID_BYTES: usize = 256;
const MAX_TEXT_BYTES: usize = 512;
const MAX_REVISION_BYTES: usize = 160;
/// Provider adapters may expose a native effort label that Omnia does not
/// know yet.  Keep that evidence bounded and content-free instead of
/// collapsing it into a misleading Omnia vocabulary value.
const MAX_EFFECTIVE_EFFORT_BYTES: usize = 80;
const VALID_EFFORTS: &[&str] = &["fast", "balanced", "deep", "ultra", "custom"];

/// Native storage representation.  It contains no URL, credential handle,
/// request body, response, cookie, path, attachment bytes, or reasoning text.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAttemptLineageFact {
    pub schema_version: u32,
    #[serde(rename = "lineageFactId")]
    pub id: String,
    pub frozen_provider_input_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub provider_profile_id: String,
    pub model_id: String,
    pub provider_definition_schema_version: u32,
    pub provider_definition_sha256: String,
    pub endpoint_fingerprint_sha256: String,
    pub adapter_revision: String,
    pub catalog_snapshot_id: Option<String>,
    pub catalog_snapshot_sha256: Option<String>,
    pub model_descriptor_revision_id: Option<String>,
    pub model_descriptor_sha256: Option<String>,
    pub model_capability_snapshot_id: Option<String>,
    pub model_capability_snapshot_sha256: Option<String>,
    pub route_revision_id: Option<String>,
    pub routing_decision_receipt_id: Option<String>,
    pub retry_policy_revision_id: Option<String>,
    pub cache_policy_revision_id: Option<String>,
    pub cache_plan_id: Option<String>,
    pub price_snapshot_id: Option<String>,
    pub price_snapshot_sha256: Option<String>,
    pub parameter_profile_revision_id: Option<String>,
    pub resolved_parameters_sha256: String,
    pub requested_effort: Option<String>,
    pub effective_effort: Option<String>,
    pub context_manifest_id: Option<String>,
    pub context_manifest_sha256: Option<String>,
    pub authority_continuity_record_id: Option<String>,
    pub data_classification_revision_id: Option<String>,
    pub input_content_sha256: String,
    pub lineage_sha256: String,
    pub created_at_ms: i64,
}

/// Renderer-safe projection.  The endpoint fingerprint is useful for
/// diagnostics, while the actual endpoint and credential binding stay native.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAttemptLineageReceipt {
    pub schema_version: u32,
    pub lineage_fact_id: String,
    pub frozen_provider_input_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub provider_profile_id: String,
    pub model_id: String,
    pub provider_definition_schema_version: u32,
    pub provider_definition_sha256: String,
    pub endpoint_fingerprint_sha256: String,
    pub adapter_revision: String,
    pub requested_effort: Option<String>,
    pub effective_effort: Option<String>,
    pub resolved_parameters_sha256: String,
    pub context_manifest_id: Option<String>,
    pub context_manifest_sha256: Option<String>,
    pub input_content_sha256: String,
    pub created_at_ms: i64,
}

/// Exact historical read address. Unlike dispatch, this is allowed after the
/// provider profile changes or is disabled; it conveys no execution authority.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadProviderAttemptLineageRequest {
    pub conversation_id: String,
    pub branch_id: String,
    pub run_id: String,
    pub attempt_id: String,
}

impl ReadProviderAttemptLineageRequest {
    pub fn validate(&self) -> NativeResult<()> {
        validate_id("conversationId", &self.conversation_id, "conversation_")?;
        validate_id("branchId", &self.branch_id, "branch_")?;
        validate_id("runId", &self.run_id, "run_")?;
        validate_id("attemptId", &self.attempt_id, "attempt_")
    }
}

/// Native-owned preparation material.  Optional catalog/routing/cache/price
/// snapshots are intentionally not synthesized when no immutable source is
/// available yet; callers can extend the fact with a future migration.
pub struct FreezeProviderAttemptLineage<'a> {
    pub id: &'a str,
    pub frozen_provider_input: &'a FrozenProviderInput,
    pub provider_definition: &'a FrozenProviderDefinition,
    pub requested_effort: Option<&'a str>,
    pub effective_effort: Option<&'a str>,
    pub created_at_ms: i64,
}

/// The exact typed preimage for `lineage_sha256`.  Do not replace this with a
/// map or unordered structure: field order and explicit nulls are part of the
/// native contract.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderAttemptLineageHashMaterial<'a> {
    pub schema_version: u32,
    pub lineage_fact_id: &'a str,
    pub run_id: &'a str,
    pub attempt_id: &'a str,
    pub frozen_provider_input_id: &'a str,
    pub provider_profile_id: &'a str,
    pub model_id: &'a str,
    pub provider_definition_schema_version: u32,
    pub provider_definition_sha256: &'a str,
    pub endpoint_fingerprint_sha256: &'a str,
    pub adapter_revision: &'a str,
    pub catalog_snapshot_id: Option<&'a str>,
    pub catalog_snapshot_sha256: Option<&'a str>,
    pub model_descriptor_revision_id: Option<&'a str>,
    pub model_descriptor_sha256: Option<&'a str>,
    pub model_capability_snapshot_id: Option<&'a str>,
    pub model_capability_snapshot_sha256: Option<&'a str>,
    pub route_revision_id: Option<&'a str>,
    pub routing_decision_receipt_id: Option<&'a str>,
    pub retry_policy_revision_id: Option<&'a str>,
    pub cache_policy_revision_id: Option<&'a str>,
    pub cache_plan_id: Option<&'a str>,
    pub price_snapshot_id: Option<&'a str>,
    pub price_snapshot_sha256: Option<&'a str>,
    pub parameter_profile_revision_id: Option<&'a str>,
    pub resolved_parameters_sha256: &'a str,
    pub requested_effort: Option<&'a str>,
    pub effective_effort: Option<&'a str>,
    pub context_manifest_id: Option<&'a str>,
    pub context_manifest_sha256: Option<&'a str>,
    pub authority_continuity_record_id: Option<&'a str>,
    pub data_classification_revision_id: Option<&'a str>,
    pub input_content_sha256: &'a str,
    pub created_at_ms: i64,
}

impl ProviderAttemptLineageFact {
    pub fn freeze(input: FreezeProviderAttemptLineage<'_>) -> NativeResult<Self> {
        input.frozen_provider_input.validate()?;
        input.provider_definition.validate()?;
        validate_id("lineageFactId", input.id, PROVIDER_ATTEMPT_LINEAGE_PREFIX)?;
        validate_positive_timestamp(input.created_at_ms)?;
        if input.created_at_ms != input.frozen_provider_input.created_at_ms {
            return Err(NativeError::invalid(
                "createdAtMs",
                "must exactly match the frozen provider input timestamp",
            ));
        }
        validate_requested_effort(input.requested_effort)?;
        validate_effective_effort(input.effective_effort)?;

        let resolved_parameters_sha256 =
            sha256_hex(input.frozen_provider_input.parameters_json.as_bytes());
        let endpoint_fingerprint_sha256 =
            endpoint_fingerprint_sha256(&input.provider_definition.normalized_base_url);
        let mut fact = Self {
            schema_version: PROVIDER_ATTEMPT_LINEAGE_SCHEMA_VERSION,
            id: input.id.to_owned(),
            frozen_provider_input_id: input.frozen_provider_input.id.clone(),
            run_id: input.frozen_provider_input.run_id.clone(),
            attempt_id: input.frozen_provider_input.attempt_id.clone(),
            provider_profile_id: input.frozen_provider_input.provider_profile_id.clone(),
            model_id: input.frozen_provider_input.model.clone(),
            provider_definition_schema_version: input.provider_definition.schema_version,
            provider_definition_sha256: input.provider_definition.definition_sha256.clone(),
            endpoint_fingerprint_sha256,
            adapter_revision: input.provider_definition.adapter_revision.clone(),
            catalog_snapshot_id: None,
            catalog_snapshot_sha256: None,
            model_descriptor_revision_id: None,
            model_descriptor_sha256: None,
            model_capability_snapshot_id: None,
            model_capability_snapshot_sha256: None,
            route_revision_id: None,
            routing_decision_receipt_id: None,
            retry_policy_revision_id: None,
            cache_policy_revision_id: None,
            cache_plan_id: None,
            price_snapshot_id: None,
            price_snapshot_sha256: None,
            parameter_profile_revision_id: None,
            resolved_parameters_sha256,
            requested_effort: input.requested_effort.map(str::to_owned),
            effective_effort: input.effective_effort.map(str::to_owned),
            context_manifest_id: None,
            context_manifest_sha256: None,
            authority_continuity_record_id: None,
            data_classification_revision_id: None,
            input_content_sha256: input.frozen_provider_input.content_sha256.clone(),
            lineage_sha256: String::new(),
            created_at_ms: input.created_at_ms,
        };
        fact.lineage_sha256 = fact.compute_lineage_hash()?;
        Ok(fact)
    }

    pub fn validate(&self) -> NativeResult<()> {
        if self.schema_version != PROVIDER_ATTEMPT_LINEAGE_SCHEMA_VERSION {
            return Err(NativeError::new(
                "unsupported_schema",
                "The provider-attempt lineage schema version is unsupported",
            ));
        }
        validate_id("lineageFactId", &self.id, PROVIDER_ATTEMPT_LINEAGE_PREFIX)?;
        validate_id(
            "frozenProviderInputId",
            &self.frozen_provider_input_id,
            "provider_input_",
        )?;
        validate_id("runId", &self.run_id, "run_")?;
        validate_id("attemptId", &self.attempt_id, "attempt_")?;
        validate_id("providerProfileId", &self.provider_profile_id, "provider_")?;
        validate_nonempty_bounded("modelId", &self.model_id, MAX_TEXT_BYTES)?;
        validate_positive_timestamp(self.created_at_ms)?;
        if self.provider_definition_schema_version != FROZEN_PROVIDER_DEFINITION_SCHEMA_VERSION {
            return Err(NativeError::new(
                "unsupported_schema",
                "The frozen provider definition schema version is unsupported",
            ));
        }
        validate_sha256("providerDefinitionSha256", &self.provider_definition_sha256)?;
        validate_sha256(
            "endpointFingerprintSha256",
            &self.endpoint_fingerprint_sha256,
        )?;
        validate_sha256("resolvedParametersSha256", &self.resolved_parameters_sha256)?;
        validate_sha256("inputContentSha256", &self.input_content_sha256)?;
        validate_sha256("lineageSha256", &self.lineage_sha256)?;
        validate_nonempty_bounded(
            "adapterRevision",
            &self.adapter_revision,
            MAX_REVISION_BYTES,
        )?;
        validate_requested_effort(self.requested_effort.as_deref())?;
        validate_effective_effort(self.effective_effort.as_deref())?;
        validate_optional_pair(
            "catalogSnapshotId",
            self.catalog_snapshot_id.as_deref(),
            "catalogSnapshotSha256",
            self.catalog_snapshot_sha256.as_deref(),
        )?;
        validate_optional_pair(
            "modelDescriptorRevisionId",
            self.model_descriptor_revision_id.as_deref(),
            "modelDescriptorSha256",
            self.model_descriptor_sha256.as_deref(),
        )?;
        validate_optional_pair(
            "modelCapabilitySnapshotId",
            self.model_capability_snapshot_id.as_deref(),
            "modelCapabilitySnapshotSha256",
            self.model_capability_snapshot_sha256.as_deref(),
        )?;
        validate_optional_pair(
            "priceSnapshotId",
            self.price_snapshot_id.as_deref(),
            "priceSnapshotSha256",
            self.price_snapshot_sha256.as_deref(),
        )?;
        validate_optional_pair(
            "contextManifestId",
            self.context_manifest_id.as_deref(),
            "contextManifestSha256",
            self.context_manifest_sha256.as_deref(),
        )?;
        for (field, value) in [
            ("routeRevisionId", self.route_revision_id.as_deref()),
            (
                "routingDecisionReceiptId",
                self.routing_decision_receipt_id.as_deref(),
            ),
            (
                "retryPolicyRevisionId",
                self.retry_policy_revision_id.as_deref(),
            ),
            (
                "cachePolicyRevisionId",
                self.cache_policy_revision_id.as_deref(),
            ),
            ("cachePlanId", self.cache_plan_id.as_deref()),
            (
                "parameterProfileRevisionId",
                self.parameter_profile_revision_id.as_deref(),
            ),
            (
                "authorityContinuityRecordId",
                self.authority_continuity_record_id.as_deref(),
            ),
            (
                "dataClassificationRevisionId",
                self.data_classification_revision_id.as_deref(),
            ),
        ] {
            if let Some(value) = value {
                validate_nonempty_bounded(field, value, MAX_ID_BYTES)?;
            }
        }
        if self.compute_lineage_hash()? != self.lineage_sha256 {
            return Err(NativeError::new(
                "provider_attempt_lineage_integrity_failed",
                "The immutable provider-attempt lineage hash does not match its facts",
            ));
        }
        Ok(())
    }

    pub fn assert_frozen_input(&self, input: &FrozenProviderInput) -> NativeResult<()> {
        self.validate()?;
        input.validate()?;
        if self.frozen_provider_input_id != input.id
            || self.run_id != input.run_id
            || self.attempt_id != input.attempt_id
            || self.provider_profile_id != input.provider_profile_id
            || self.model_id != input.model
            || self.input_content_sha256 != input.content_sha256
            || self.created_at_ms != input.created_at_ms
        {
            return Err(NativeError::new(
                "provider_attempt_lineage_scope_conflict",
                "The immutable provider-attempt lineage does not match the frozen provider input",
            ));
        }
        if self.resolved_parameters_sha256 != sha256_hex(input.parameters_json.as_bytes()) {
            return Err(provider_attempt_lineage_parameters_changed());
        }
        Ok(())
    }

    /// Binds the immutable fact to the two opaque identities supplied by the
    /// dispatch command.  Storage remains responsible for loading the row and
    /// checking the surrounding SQLite transaction; this method owns the
    /// semantic scope comparison so preparation and dispatch cannot grow
    /// different checks over time.
    pub fn assert_dispatch_scope(&self, request: &StartPreparedAttemptRequest) -> NativeResult<()> {
        self.validate()?;
        request.validate()?;
        if self.frozen_provider_input_id != request.frozen_provider_input_id
            || self.attempt_id != request.attempt_id
        {
            return Err(NativeError::new(
                "provider_attempt_lineage_scope_conflict",
                "The immutable provider-attempt lineage does not match the dispatch request",
            ));
        }
        Ok(())
    }

    /// Validates the bounded effort interpretation that preparation recorded
    /// alongside the exact frozen parameter bytes.  Storage owns parsing the
    /// provider parameter object; this typed contract owns binding the parsed
    /// provenance to the immutable fact and its canonical hash.
    pub fn assert_effort_provenance(
        &self,
        requested_effort: Option<&str>,
        effective_effort: Option<&str>,
    ) -> NativeResult<()> {
        self.validate()?;
        validate_requested_effort(requested_effort)?;
        validate_effective_effort(effective_effort)?;
        if self.requested_effort.as_deref() != requested_effort
            || self.effective_effort.as_deref() != effective_effort
        {
            return Err(provider_attempt_lineage_parameters_changed());
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn assert_live_definition(&self, live: &FrozenProviderDefinition) -> NativeResult<()> {
        self.validate()?;
        live.validate().map_err(|_| provider_definition_changed())?;
        if self.provider_profile_id != live.provider_profile_id
            || self.provider_definition_schema_version != live.schema_version
            || self.provider_definition_sha256 != live.definition_sha256
            || self.adapter_revision != live.adapter_revision
            || self.endpoint_fingerprint_sha256
                != endpoint_fingerprint_sha256(&live.normalized_base_url)
        {
            return Err(provider_definition_changed());
        }
        Ok(())
    }

    pub fn receipt(&self) -> NativeResult<ProviderAttemptLineageReceipt> {
        self.validate()?;
        Ok(ProviderAttemptLineageReceipt {
            schema_version: self.schema_version,
            lineage_fact_id: self.id.clone(),
            frozen_provider_input_id: self.frozen_provider_input_id.clone(),
            run_id: self.run_id.clone(),
            attempt_id: self.attempt_id.clone(),
            provider_profile_id: self.provider_profile_id.clone(),
            model_id: self.model_id.clone(),
            provider_definition_schema_version: self.provider_definition_schema_version,
            provider_definition_sha256: self.provider_definition_sha256.clone(),
            endpoint_fingerprint_sha256: self.endpoint_fingerprint_sha256.clone(),
            adapter_revision: self.adapter_revision.clone(),
            requested_effort: self.requested_effort.clone(),
            effective_effort: self.effective_effort.clone(),
            resolved_parameters_sha256: self.resolved_parameters_sha256.clone(),
            context_manifest_id: self.context_manifest_id.clone(),
            context_manifest_sha256: self.context_manifest_sha256.clone(),
            input_content_sha256: self.input_content_sha256.clone(),
            created_at_ms: self.created_at_ms,
        })
    }

    pub(crate) fn compute_lineage_hash(&self) -> NativeResult<String> {
        let material = ProviderAttemptLineageHashMaterial {
            schema_version: self.schema_version,
            lineage_fact_id: &self.id,
            run_id: &self.run_id,
            attempt_id: &self.attempt_id,
            frozen_provider_input_id: &self.frozen_provider_input_id,
            provider_profile_id: &self.provider_profile_id,
            model_id: &self.model_id,
            provider_definition_schema_version: self.provider_definition_schema_version,
            provider_definition_sha256: &self.provider_definition_sha256,
            endpoint_fingerprint_sha256: &self.endpoint_fingerprint_sha256,
            adapter_revision: &self.adapter_revision,
            catalog_snapshot_id: self.catalog_snapshot_id.as_deref(),
            catalog_snapshot_sha256: self.catalog_snapshot_sha256.as_deref(),
            model_descriptor_revision_id: self.model_descriptor_revision_id.as_deref(),
            model_descriptor_sha256: self.model_descriptor_sha256.as_deref(),
            model_capability_snapshot_id: self.model_capability_snapshot_id.as_deref(),
            model_capability_snapshot_sha256: self.model_capability_snapshot_sha256.as_deref(),
            route_revision_id: self.route_revision_id.as_deref(),
            routing_decision_receipt_id: self.routing_decision_receipt_id.as_deref(),
            retry_policy_revision_id: self.retry_policy_revision_id.as_deref(),
            cache_policy_revision_id: self.cache_policy_revision_id.as_deref(),
            cache_plan_id: self.cache_plan_id.as_deref(),
            price_snapshot_id: self.price_snapshot_id.as_deref(),
            price_snapshot_sha256: self.price_snapshot_sha256.as_deref(),
            parameter_profile_revision_id: self.parameter_profile_revision_id.as_deref(),
            resolved_parameters_sha256: &self.resolved_parameters_sha256,
            requested_effort: self.requested_effort.as_deref(),
            effective_effort: self.effective_effort.as_deref(),
            context_manifest_id: self.context_manifest_id.as_deref(),
            context_manifest_sha256: self.context_manifest_sha256.as_deref(),
            authority_continuity_record_id: self.authority_continuity_record_id.as_deref(),
            data_classification_revision_id: self.data_classification_revision_id.as_deref(),
            input_content_sha256: &self.input_content_sha256,
            created_at_ms: self.created_at_ms,
        };
        canonical_hash(&material)
    }
}

pub(crate) fn canonical_hash(
    material: &ProviderAttemptLineageHashMaterial<'_>,
) -> NativeResult<String> {
    let bytes = serde_json::to_vec(material).map_err(|_| {
        NativeError::new(
            "provider_attempt_lineage_integrity_failed",
            "The provider-attempt lineage material could not be canonicalized",
        )
    })?;
    Ok(sha256_hex(bytes))
}

pub(crate) fn endpoint_fingerprint_sha256(normalized_base_url: &str) -> String {
    let mut preimage =
        Vec::with_capacity(ENDPOINT_FINGERPRINT_DOMAIN.len() + normalized_base_url.len());
    preimage.extend_from_slice(ENDPOINT_FINGERPRINT_DOMAIN);
    preimage.extend_from_slice(normalized_base_url.as_bytes());
    sha256_hex(preimage)
}

fn validate_id(field: &'static str, value: &str, prefix: &str) -> NativeResult<()> {
    let suffix = value.strip_prefix(prefix);
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || suffix.map_or(true, |suffix| {
            suffix.len() != 32
                || !suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        || value.chars().any(char::is_control)
    {
        return Err(NativeError::invalid(
            field,
            format!("must be a bounded opaque identifier beginning with {prefix:?}"),
        ));
    }
    Ok(())
}

fn validate_nonempty_bounded(
    field: &'static str,
    value: &str,
    max_bytes: usize,
) -> NativeResult<()> {
    if value.trim().is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(NativeError::invalid(
            field,
            "must be non-empty, bounded, and free of control characters",
        ));
    }
    Ok(())
}

fn validate_positive_timestamp(value: i64) -> NativeResult<()> {
    if value <= 0 {
        return Err(NativeError::invalid(
            "createdAtMs",
            "must be a positive Unix timestamp",
        ));
    }
    Ok(())
}

fn validate_sha256(field: &'static str, value: &str) -> NativeResult<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(NativeError::invalid(
            field,
            "must be a lower-case SHA-256 digest",
        ));
    }
    Ok(())
}

fn validate_requested_effort(value: Option<&str>) -> NativeResult<()> {
    if let Some(value) = value {
        if !VALID_EFFORTS.contains(&value) {
            return Err(NativeError::invalid(
                "requestedEffort",
                "must use a bounded Omnia effort vocabulary",
            ));
        }
    }
    Ok(())
}

fn validate_effective_effort(value: Option<&str>) -> NativeResult<()> {
    if let Some(value) = value {
        // `effectiveEffort` is adapter evidence.  Preserve an unknown
        // provider-native label verbatim (within a small bounded text field)
        // so future adapters remain observable without changing this schema.
        validate_nonempty_bounded("effectiveEffort", value, MAX_EFFECTIVE_EFFORT_BYTES)?;
    }
    Ok(())
}

/// Returns an exact Omnia effort value from a parsed parameter object, or
/// `None` when the value is absent, provider-specific, or otherwise not
/// evidenced by the closed Omnia vocabulary.  Storage owns JSON key lookup;
/// the vocabulary itself stays authoritative in this typed module.
pub(crate) fn recognized_effort(value: Option<&str>) -> Option<&str> {
    value.filter(|candidate| VALID_EFFORTS.contains(candidate))
}

fn validate_optional_pair(
    id_field: &'static str,
    id: Option<&str>,
    hash_field: &'static str,
    hash: Option<&str>,
) -> NativeResult<()> {
    if id.is_some() != hash.is_some() {
        return Err(NativeError::new(
            "provider_attempt_lineage_integrity_failed",
            format!("{id_field} and {hash_field} must be both known or both unknown"),
        ));
    }
    if let Some(id) = id {
        validate_nonempty_bounded(id_field, id, MAX_ID_BYTES)?;
    }
    if let Some(hash) = hash {
        validate_sha256(hash_field, hash)?;
    }
    Ok(())
}

#[cfg(test)]
fn provider_definition_changed() -> NativeError {
    NativeError::new(
        "provider_attempt_lineage_definition_changed",
        "The provider definition changed after this attempt was prepared",
    )
}

fn provider_attempt_lineage_parameters_changed() -> NativeError {
    NativeError::new(
        "provider_attempt_lineage_parameters_changed",
        "The prepared provider parameters no longer match immutable lineage",
    )
}

fn sha256_hex(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prepared_provider_input::{FreezeProviderInput, FrozenProviderMessage};
    use crate::provider_definition::{FreezeProviderDefinition, NATIVE_PROVIDER_ADAPTER_REVISION};

    const PROVIDER: &str = "provider_0123456789abcdef0123456789abcdef";
    const ATTEMPT: &str = "attempt_0123456789abcdef0123456789abcdef";
    const RUN: &str = "run_0123456789abcdef0123456789abcdef";
    const INPUT: &str = "provider_input_0123456789abcdef0123456789abcdef";
    const LINEAGE: &str = "provider_lineage_0123456789abcdef0123456789abcdef";
    const CREDENTIAL: &str = "provider_secret_0123456789abcdef0123456789abcdef";

    fn input() -> FrozenProviderInput {
        FrozenProviderInput::freeze(FreezeProviderInput {
            id: INPUT,
            attempt_id: ATTEMPT,
            run_id: RUN,
            provider_profile_id: PROVIDER,
            model: "gpt-test",
            messages: &[FrozenProviderMessage {
                role: "user".to_owned(),
                content: "hello".to_owned(),
            }],
            parameters_json: r#"{"temperature":0.2}"#,
            created_at_ms: 1_700_000_000_000,
        })
        .expect("input should freeze")
    }

    fn definition() -> FrozenProviderDefinition {
        FrozenProviderDefinition::freeze(FreezeProviderDefinition {
            provider_profile_id: PROVIDER,
            provider_type: "openai_compatible",
            normalized_base_url: "https://api.example.com/v1",
            auth_scheme: "bearer",
            organization_id: None,
            remote_project_id: None,
            credential_ref: Some(CREDENTIAL),
            local_network_grant: false,
            adapter_revision: NATIVE_PROVIDER_ADAPTER_REVISION,
        })
        .expect("definition should freeze")
    }

    #[test]
    fn lineage_hash_is_deterministic_and_receipt_is_secret_free() {
        let first = ProviderAttemptLineageFact::freeze(FreezeProviderAttemptLineage {
            id: LINEAGE,
            frozen_provider_input: &input(),
            provider_definition: &definition(),
            requested_effort: Some("deep"),
            effective_effort: None,
            created_at_ms: 1_700_000_000_000,
        })
        .expect("lineage should freeze");
        let second = ProviderAttemptLineageFact::freeze(FreezeProviderAttemptLineage {
            id: LINEAGE,
            frozen_provider_input: &input(),
            provider_definition: &definition(),
            requested_effort: Some("deep"),
            effective_effort: None,
            created_at_ms: 1_700_000_000_000,
        })
        .expect("lineage should freeze");
        assert_eq!(first, second);
        first.validate().expect("lineage should validate");
        let receipt = first.receipt().expect("receipt should validate");
        let fact_json = serde_json::to_value(&first).expect("fact should serialize");
        let fact_object = fact_json
            .as_object()
            .expect("fact serialization should be an object");
        assert!(fact_object.contains_key("lineageFactId"));
        assert!(!fact_object.contains_key("id"));
        for required in [
            "modelId",
            "inputContentSha256",
            "lineageSha256",
            "createdAtMs",
            "routingDecisionReceiptId",
            "cachePlanId",
        ] {
            assert!(fact_object.contains_key(required), "missing {required}");
        }
        assert!(fact_object["routingDecisionReceiptId"].is_null());
        assert!(fact_object["cachePlanId"].is_null());
        assert!(fact_object["contextManifestId"].is_null());
        assert!(fact_object["contextManifestSha256"].is_null());
        let fact_serialized = serde_json::to_string(&first).expect("fact should serialize");
        for forbidden in [
            "api.example.com",
            CREDENTIAL,
            "authorization",
            "headers",
            "cookies",
            "hello",
            "C:\\",
            "/Users/",
        ] {
            assert!(
                !fact_serialized.contains(forbidden),
                "fact leaked forbidden value {forbidden:?}"
            );
        }
        let serialized = serde_json::to_string(&receipt).expect("receipt should serialize");
        assert!(!serialized.contains("api.example.com"));
        assert!(!serialized.contains(CREDENTIAL));
        assert!(!serialized.contains("hello"));

        let receipt_object = serde_json::to_value(&receipt)
            .expect("receipt should serialize")
            .as_object()
            .cloned()
            .expect("receipt serialization should be an object");
        let allowlist = [
            "schemaVersion",
            "lineageFactId",
            "frozenProviderInputId",
            "runId",
            "attemptId",
            "providerProfileId",
            "modelId",
            "providerDefinitionSchemaVersion",
            "providerDefinitionSha256",
            "endpointFingerprintSha256",
            "adapterRevision",
            "requestedEffort",
            "effectiveEffort",
            "resolvedParametersSha256",
            "contextManifestId",
            "contextManifestSha256",
            "inputContentSha256",
            "createdAtMs",
        ];
        assert_eq!(receipt_object.len(), allowlist.len());
        for key in receipt_object.keys() {
            assert!(
                allowlist.contains(&key.as_str()),
                "unexpected receipt key {key}"
            );
        }
    }

    #[test]
    fn tampered_hash_and_scope_fail_closed() {
        let mut fact = ProviderAttemptLineageFact::freeze(FreezeProviderAttemptLineage {
            id: LINEAGE,
            frozen_provider_input: &input(),
            provider_definition: &definition(),
            requested_effort: None,
            effective_effort: None,
            created_at_ms: 1_700_000_000_000,
        })
        .expect("lineage should freeze");
        fact.lineage_sha256 = "0".repeat(64);
        assert_eq!(
            fact.validate().expect_err("tampering must fail").code,
            "provider_attempt_lineage_integrity_failed"
        );

        let fact = ProviderAttemptLineageFact::freeze(FreezeProviderAttemptLineage {
            id: LINEAGE,
            frozen_provider_input: &input(),
            provider_definition: &definition(),
            requested_effort: None,
            effective_effort: None,
            created_at_ms: 1_700_000_000_000,
        })
        .expect("lineage should freeze");
        // A hand-edited model without a recomputed content hash is rejected as
        // an integrity failure before any scope comparison happens.
        let mut tampered = input();
        tampered.model = "other-model".to_owned();
        assert_eq!(
            fact.assert_frozen_input(&tampered)
                .expect_err("unhashed model edit must fail integrity validation")
                .code,
            "prepared_input_integrity_failed"
        );
        // A legitimately frozen input for a different model is a scope conflict.
        let other = FrozenProviderInput::freeze(FreezeProviderInput {
            id: INPUT,
            attempt_id: ATTEMPT,
            run_id: RUN,
            provider_profile_id: PROVIDER,
            model: "other-model",
            messages: &[FrozenProviderMessage {
                role: "user".to_owned(),
                content: "hello".to_owned(),
            }],
            parameters_json: r#"{"temperature":0.2}"#,
            created_at_ms: 1_700_000_000_000,
        })
        .expect("other-model input should freeze");
        assert_eq!(
            fact.assert_frozen_input(&other)
                .expect_err("cross-model input must fail")
                .code,
            "provider_attempt_lineage_scope_conflict"
        );
    }

    #[test]
    fn creation_time_is_bound_to_the_frozen_provider_input() {
        let frozen_input = input();
        let error = ProviderAttemptLineageFact::freeze(FreezeProviderAttemptLineage {
            id: LINEAGE,
            frozen_provider_input: &frozen_input,
            provider_definition: &definition(),
            requested_effort: None,
            effective_effort: None,
            created_at_ms: frozen_input.created_at_ms + 1,
        })
        .expect_err("lineage timestamp must be bound to frozen input");

        assert_eq!(error.code, "invalid_input");
    }

    #[test]
    fn endpoint_fingerprint_is_domain_separated_from_the_raw_endpoint_hash() {
        let endpoint = "https://api.example.com/v1";
        assert_ne!(
            endpoint_fingerprint_sha256(endpoint),
            sha256_hex(endpoint.as_bytes())
        );
    }
}
