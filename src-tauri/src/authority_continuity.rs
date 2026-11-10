//! Native-owned authority-continuity correlation for run-control receipts.
//!
//! This projection is intentionally narrower than the full authority-
//! continuity schema in `docs/omnia-ultra/schemas/authority-continuity.schema.json`.
//! A run-control resolver does not have enough evidence to evaluate current
//! policy, grants, environment, provider credentials, or external side
//! effects.  It therefore records an immutable, redacted *not-evaluated*
//! checkpoint instead of inventing an allow/deny decision.
//!
//! The projection is stored inside the immutable operation/state-revision
//! envelopes.  It is a correlation and lifecycle fact, not a permission
//! token.  Dispatch code must perform a fresh authority evaluation.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{NativeError, NativeResult};

pub const AUTHORITY_CONTINUITY_SCHEMA_VERSION: u32 = 1;
pub const AUTHORITY_CONTINUITY_RECORD_PREFIX: &str = "authority_continuity_";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAuthorityContinuityProjection {
    pub schema_version: u32,
    pub contract: String,
    pub record_id: String,
    pub operation_id: String,
    pub actor: NativeAuthorityActor,
    pub target: NativeAuthorityTarget,
    pub source_status: String,
    pub effective_status: String,
    pub effect_state: String,
    pub projection_state: String,
    pub reconciliation: String,
    pub idempotency: String,
    pub same_attempt_retry_allowed: bool,
    pub reason_codes: Vec<String>,
    pub secret_material_mode: String,
    pub redaction: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAuthorityActor {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAuthorityTarget {
    pub conversation_id: String,
    pub branch_id: String,
    pub operation_kind: String,
}

/// Derives a stable opaque record address from the immutable operation ID.
/// The operation ID is not copied into a path or exposed as a secret; the
/// digest prevents accidental collisions while keeping the record bounded.
pub fn record_id(operation_id: &str) -> String {
    let digest = Sha256::digest(operation_id.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push(char::from(b"0123456789abcdef"[(byte >> 4) as usize]));
        hex.push(char::from(b"0123456789abcdef"[(byte & 0x0f) as usize]));
    }
    format!("{AUTHORITY_CONTINUITY_RECORD_PREFIX}{hex}")
}

pub fn validate_record_id(value: &str) -> NativeResult<()> {
    let suffix = value
        .strip_prefix(AUTHORITY_CONTINUITY_RECORD_PREFIX)
        .ok_or_else(|| {
            NativeError::invalid(
                "authorityContinuityRecordId",
                "must use the native authority-continuity record prefix",
            )
        })?;
    if suffix.len() != 64 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(NativeError::invalid(
            "authorityContinuityRecordId",
            "must contain a 64-character hexadecimal digest",
        ));
    }
    Ok(())
}

/// Builds the resolver-owned checkpoint.  `not-evaluated` is deliberate:
/// current policy/grant/environment checks happen later at the side-effect
/// broker and are never inferred from this record.
pub fn build_run_control_projection(
    operation_id: &str,
    actor_kind: &str,
    actor_id: &str,
    conversation_id: &str,
    branch_id: &str,
    operation_kind: &str,
    created_at: &str,
) -> NativeResult<(String, String)> {
    if operation_id.trim().is_empty()
        || actor_kind.trim().is_empty()
        || actor_id.trim().is_empty()
        || conversation_id.trim().is_empty()
        || branch_id.trim().is_empty()
        || operation_kind.trim().is_empty()
        || created_at.trim().is_empty()
    {
        return Err(NativeError::invalid(
            "authorityContinuity",
            "operation, actor, target, and timestamp fields are required",
        ));
    }
    if [
        operation_id,
        actor_kind,
        actor_id,
        conversation_id,
        branch_id,
        operation_kind,
        created_at,
    ]
    .iter()
    .any(|value| value.chars().any(char::is_control))
    {
        return Err(NativeError::invalid(
            "authorityContinuity",
            "fields must not contain control characters",
        ));
    }

    let record_id = record_id(operation_id);
    let projection = NativeAuthorityContinuityProjection {
        schema_version: AUTHORITY_CONTINUITY_SCHEMA_VERSION,
        contract: "native-run-control-authority-continuity-v1".to_owned(),
        record_id: record_id.clone(),
        operation_id: operation_id.to_owned(),
        actor: NativeAuthorityActor {
            kind: actor_kind.to_owned(),
            id: actor_id.to_owned(),
        },
        target: NativeAuthorityTarget {
            conversation_id: conversation_id.to_owned(),
            branch_id: branch_id.to_owned(),
            operation_kind: operation_kind.to_owned(),
        },
        source_status: "not-evaluated".to_owned(),
        effective_status: "not-evaluated".to_owned(),
        effect_state: "none".to_owned(),
        projection_state: "not-started".to_owned(),
        reconciliation: "not-required".to_owned(),
        idempotency: "none".to_owned(),
        same_attempt_retry_allowed: false,
        reason_codes: vec![
            "run-control-resolver-only".to_owned(),
            "current-authority-evaluation-not-observed".to_owned(),
            "external-effects-not-authorized".to_owned(),
        ],
        secret_material_mode: "none".to_owned(),
        redaction: "renderer-safe".to_owned(),
        created_at: created_at.to_owned(),
    };
    let json = serde_json::to_string(&projection).map_err(|_| {
        NativeError::new(
            "run_control_integrity_failed",
            "The authority-continuity projection could not be serialized",
        )
    })?;
    Ok((record_id, json))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_id_is_stable_and_opaque() {
        let first = record_id("operation_0123456789abcdef0123456789abcdef");
        assert_eq!(
            first,
            record_id("operation_0123456789abcdef0123456789abcdef")
        );
        validate_record_id(&first).expect("derived ID should validate");
        assert!(!first.contains("operation_"));
    }

    #[test]
    fn projection_is_explicitly_not_evaluated_and_has_no_retry_authority() {
        let (record_id, json) = build_run_control_projection(
            "operation_0123456789abcdef0123456789abcdef",
            "user",
            "user_local",
            "conversation_0123456789abcdef0123456789abcdef",
            "branch_0123456789abcdef0123456789abcdef",
            "retry",
            "2026-09-24T00:00:00Z",
        )
        .expect("projection should build");
        let projection: NativeAuthorityContinuityProjection =
            serde_json::from_str(&json).expect("projection should round-trip");
        assert_eq!(projection.record_id, record_id);
        assert_eq!(projection.source_status, "not-evaluated");
        assert_eq!(projection.effective_status, "not-evaluated");
        assert_eq!(projection.effect_state, "none");
        assert!(!projection.same_attempt_retry_allowed);
        assert!(projection
            .reason_codes
            .iter()
            .any(|reason| reason == "external-effects-not-authorized"));
    }
}
