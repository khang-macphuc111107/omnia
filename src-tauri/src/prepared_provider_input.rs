//! Immutable native-owned provider input contracts.
//!
//! The renderer must never author a second copy of provider messages or
//! parameters at dispatch time.  Native preparation creates a frozen input,
//! records its content hash, and returns only an opaque receipt.  The provider
//! gateway can later resolve this record by `frozenProviderInputId` after
//! checking the exact attempt scope.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{NativeError, NativeResult};

pub const FROZEN_PROVIDER_INPUT_SCHEMA_VERSION: u32 = 1;
pub const FROZEN_PROVIDER_INPUT_PREFIX: &str = "provider_input_";

const MAX_ID_BYTES: usize = 200;
const MAX_MODEL_BYTES: usize = 512;
const MAX_MESSAGES: usize = 2_000;
const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_PARAMETERS_BYTES: usize = 256 * 1024;

/// The dispatch command intentionally contains no messages, parameters,
/// attachments, provider URLs, credentials, paths, or bytes.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartPreparedAttemptRequest {
    pub attempt_id: String,
    pub frozen_provider_input_id: String,
}

impl StartPreparedAttemptRequest {
    pub fn validate(&self) -> NativeResult<()> {
        validate_prefixed_id("attemptId", &self.attempt_id, "attempt_")?;
        validate_prefixed_id(
            "frozenProviderInputId",
            &self.frozen_provider_input_id,
            FROZEN_PROVIDER_INPUT_PREFIX,
        )?;
        Ok(())
    }
}

/// A renderer-safe projection of a frozen input.  It carries enough metadata
/// for an inspector, but never exposes the provider request body.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedProviderInputReceipt {
    pub id: String,
    pub attempt_id: String,
    pub run_id: String,
    pub provider_profile_id: String,
    pub model: String,
    pub content_sha256: String,
    pub message_count: usize,
    pub created_at_ms: i64,
}

/// Preparation result returned to the renderer.  The conversation projection
/// remains available for immediate UI hydration, while provider dispatch uses
/// only the opaque frozen-input receipt.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedConversationRun<T> {
    pub conversation: T,
    pub provider_input: PreparedProviderInputReceipt,
}

/// A native-owned message in the frozen provider input.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrozenProviderMessage {
    pub role: String,
    pub content: String,
}

/// Immutable provider input persisted by native storage.
///
/// `parameters_json` is retained as canonical JSON text for adapter-specific
/// translation.  It is never accepted from the dispatch command; only the
/// preparation transaction may create this record.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrozenProviderInput {
    pub schema_version: u32,
    pub id: String,
    pub attempt_id: String,
    pub run_id: String,
    pub provider_profile_id: String,
    pub model: String,
    pub messages: Vec<FrozenProviderMessage>,
    pub parameters_json: String,
    pub content_sha256: String,
    pub created_at_ms: i64,
}

/// Borrowed input used only by the native preparation transaction.
pub struct FreezeProviderInput<'a> {
    pub id: &'a str,
    pub attempt_id: &'a str,
    pub run_id: &'a str,
    pub provider_profile_id: &'a str,
    pub model: &'a str,
    pub messages: &'a [FrozenProviderMessage],
    pub parameters_json: &'a str,
    pub created_at_ms: i64,
}

impl FrozenProviderInput {
    /// Validates and freezes a provider input.  The hash is computed from the
    /// normalized, native-owned material rather than supplied by the caller.
    pub fn freeze(input: FreezeProviderInput<'_>) -> NativeResult<Self> {
        validate_prefixed_id(
            "frozenProviderInputId",
            input.id,
            FROZEN_PROVIDER_INPUT_PREFIX,
        )?;
        validate_prefixed_id("attemptId", input.attempt_id, "attempt_")?;
        validate_prefixed_id("runId", input.run_id, "run_")?;
        validate_prefixed_id("providerProfileId", input.provider_profile_id, "provider_")?;
        let model = validate_identifier_text("model", input.model, MAX_MODEL_BYTES)?;
        if input.created_at_ms <= 0 {
            return Err(NativeError::invalid("createdAtMs", "must be positive"));
        }
        if input.messages.is_empty() || input.messages.len() > MAX_MESSAGES {
            return Err(NativeError::invalid(
                "messages",
                "must contain between 1 and 2000 messages",
            ));
        }
        let mut total_message_bytes = 0usize;
        let messages = input
            .messages
            .iter()
            .map(|message| {
                let role = validate_role(&message.role)?;
                let content = validate_message_content(&message.content)?;
                total_message_bytes = total_message_bytes
                    .checked_add(content.len())
                    .ok_or_else(|| NativeError::invalid("messages", "are too large"))?;
                Ok(FrozenProviderMessage { role, content })
            })
            .collect::<NativeResult<Vec<_>>>()?;
        if total_message_bytes > MAX_MESSAGE_BYTES {
            return Err(NativeError::invalid(
                "messages",
                "exceed the request safety limit",
            ));
        }
        let parameters_json = canonical_parameters(input.parameters_json)?;
        let content_sha256 = hash_material(
            input.id,
            input.attempt_id,
            input.run_id,
            input.provider_profile_id,
            &model,
            &messages,
            &parameters_json,
        )?;
        Ok(Self {
            schema_version: FROZEN_PROVIDER_INPUT_SCHEMA_VERSION,
            id: input.id.to_owned(),
            attempt_id: input.attempt_id.to_owned(),
            run_id: input.run_id.to_owned(),
            provider_profile_id: input.provider_profile_id.to_owned(),
            model,
            messages,
            parameters_json,
            content_sha256,
            created_at_ms: input.created_at_ms,
        })
    }

    /// Revalidates a value loaded from SQLite or a recovery journal.  This is
    /// intentionally strict: a hash mismatch is a storage-integrity failure,
    /// not a request that may be repaired at dispatch time.
    pub fn validate(&self) -> NativeResult<()> {
        if self.schema_version != FROZEN_PROVIDER_INPUT_SCHEMA_VERSION {
            return Err(NativeError::new(
                "unsupported_schema",
                "The frozen provider input schema version is unsupported",
            ));
        }
        let rebuilt = Self::freeze(FreezeProviderInput {
            id: &self.id,
            attempt_id: &self.attempt_id,
            run_id: &self.run_id,
            provider_profile_id: &self.provider_profile_id,
            model: &self.model,
            messages: &self.messages,
            parameters_json: &self.parameters_json,
            created_at_ms: self.created_at_ms,
        })?;
        if rebuilt.content_sha256 != self.content_sha256 {
            return Err(NativeError::new(
                "prepared_input_integrity_failed",
                "The frozen provider input content hash does not match its body",
            ));
        }
        Ok(())
    }

    /// Checks the one identity supplied by the dispatch command.  The caller
    /// must additionally compare run/profile/model against its active attempt
    /// row in the same native transaction.
    pub fn assert_dispatch_scope(&self, request: &StartPreparedAttemptRequest) -> NativeResult<()> {
        request.validate()?;
        if self.attempt_id != request.attempt_id {
            return Err(NativeError::new(
                "prepared_input_scope_conflict",
                "The frozen provider input belongs to another provider attempt",
            ));
        }
        Ok(())
    }

    pub fn receipt(&self) -> PreparedProviderInputReceipt {
        PreparedProviderInputReceipt {
            id: self.id.clone(),
            attempt_id: self.attempt_id.clone(),
            run_id: self.run_id.clone(),
            provider_profile_id: self.provider_profile_id.clone(),
            model: self.model.clone(),
            content_sha256: self.content_sha256.clone(),
            message_count: self.messages.len(),
            created_at_ms: self.created_at_ms,
        }
    }
}

fn validate_prefixed_id(label: &'static str, value: &str, prefix: &str) -> NativeResult<()> {
    let normalized = value.trim();
    let suffix = normalized.strip_prefix(prefix);
    if normalized.is_empty()
        || normalized.len() > MAX_ID_BYTES
        || suffix.map_or(true, |value| {
            value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        || normalized.chars().any(|character| character.is_control())
    {
        return Err(NativeError::invalid(
            label,
            format!("must be a bounded identifier beginning with {prefix:?}"),
        ));
    }
    Ok(())
}

fn validate_identifier_text(
    label: &'static str,
    value: &str,
    max_bytes: usize,
) -> NativeResult<String> {
    if value.chars().any(|character| character.is_control()) {
        return Err(NativeError::invalid(label, "contains a control character"));
    }
    if value.trim().is_empty() {
        return Err(NativeError::invalid(label, "cannot be empty"));
    }
    if value.len() > max_bytes {
        return Err(NativeError::invalid(
            label,
            "exceeds the request safety limit",
        ));
    }
    Ok(value.to_owned())
}

fn validate_message_content(value: &str) -> NativeResult<String> {
    if value.contains('\0') {
        return Err(NativeError::invalid(
            "messages.content",
            "contains a NUL character",
        ));
    }
    if value.len() > MAX_MESSAGE_BYTES {
        return Err(NativeError::invalid(
            "messages.content",
            "exceeds the request safety limit",
        ));
    }
    Ok(value.to_owned())
}

fn validate_role(value: &str) -> NativeResult<String> {
    if !matches!(
        value,
        "system" | "developer" | "user" | "assistant" | "tool"
    ) {
        return Err(NativeError::invalid("messages.role", "is unsupported"));
    }
    Ok(value.to_owned())
}

fn canonical_parameters(value: &str) -> NativeResult<String> {
    if value.len() > MAX_PARAMETERS_BYTES {
        return Err(NativeError::invalid(
            "parameters",
            "exceed the request safety limit",
        ));
    }
    let parsed: Value = serde_json::from_str(value)
        .map_err(|_| NativeError::invalid("parameters", "must be valid JSON"))?;
    if !parsed.is_object() {
        return Err(NativeError::invalid("parameters", "must be a JSON object"));
    }
    // serde_json uses a deterministic map representation in this build.  A
    // recursive BTreeMap round-trip makes that requirement explicit and keeps
    // the hash stable if the parser's map implementation changes later.
    let canonical = canonicalize_json(parsed);
    serde_json::to_string(&canonical)
        .map_err(|_| NativeError::invalid("parameters", "could not be canonicalized"))
}

fn canonicalize_json(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize_json).collect()),
        Value::Object(values) => {
            let values: BTreeMap<String, Value> = values
                .into_iter()
                .map(|(key, value)| (key, canonicalize_json(value)))
                .collect();
            Value::Object(values.into_iter().collect())
        }
        scalar => scalar,
    }
}

fn hash_material(
    id: &str,
    attempt_id: &str,
    run_id: &str,
    provider_profile_id: &str,
    model: &str,
    messages: &[FrozenProviderMessage],
    parameters_json: &str,
) -> NativeResult<String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Material<'a> {
        schema_version: u32,
        id: &'a str,
        attempt_id: &'a str,
        run_id: &'a str,
        provider_profile_id: &'a str,
        model: &'a str,
        messages: &'a [FrozenProviderMessage],
        parameters_json: &'a str,
    }
    let bytes = serde_json::to_vec(&Material {
        schema_version: FROZEN_PROVIDER_INPUT_SCHEMA_VERSION,
        id,
        attempt_id,
        run_id,
        provider_profile_id,
        model,
        messages,
        parameters_json,
    })
    .map_err(|_| {
        NativeError::new(
            "prepared_input_integrity_failed",
            "Could not hash frozen provider input",
        )
    })?;
    let mut digest = Sha256::new();
    digest.update(bytes);
    Ok(hex_lower(&digest.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    const ATTEMPT: &str = "attempt_0123456789abcdef0123456789abcdef";
    const RUN: &str = "run_0123456789abcdef0123456789abcdef";
    const PROVIDER: &str = "provider_0123456789abcdef0123456789abcdef";
    const INPUT: &str = "provider_input_0123456789abcdef0123456789abcdef";

    fn sample() -> FrozenProviderInput {
        let messages = vec![FrozenProviderMessage {
            role: "user".into(),
            content: "Hello".into(),
        }];
        FrozenProviderInput::freeze(FreezeProviderInput {
            id: INPUT,
            attempt_id: ATTEMPT,
            run_id: RUN,
            provider_profile_id: PROVIDER,
            model: "example-model",
            messages: &messages,
            parameters_json: r#"{"temperature":0.2,"nested":{"b":2,"a":1}}"#,
            created_at_ms: 1_700_000_000_000,
        })
        .expect("sample input should be valid")
    }

    #[test]
    fn freezes_hash_and_exposes_only_opaque_receipt() {
        let input = sample();
        input.validate().expect("frozen input should validate");
        assert_eq!(input.content_sha256.len(), 64);
        let receipt = input.receipt();
        assert_eq!(receipt.id, INPUT);
        assert_eq!(receipt.message_count, 1);
        assert!(!serde_json::to_string(&receipt)
            .expect("receipt should serialize")
            .contains("Hello"));
        let serialized = serde_json::to_string(&receipt).expect("receipt should serialize");
        assert!(!serialized.contains("parameters"));
        assert!(!serialized.contains("temperature"));
    }

    #[test]
    fn canonicalizes_parameter_key_order() {
        let messages = vec![FrozenProviderMessage {
            role: "user".into(),
            content: "Hello".into(),
        }];
        let left = FrozenProviderInput::freeze(FreezeProviderInput {
            parameters_json: r#"{"b":2,"a":1}"#,
            messages: &messages,
            ..sample_input(&messages, "{}")
        })
        .expect("left should freeze");
        let right = FrozenProviderInput::freeze(FreezeProviderInput {
            parameters_json: r#"{"a":1,"b":2}"#,
            messages: &messages,
            ..sample_input(&messages, "{}")
        })
        .expect("right should freeze");
        assert_eq!(left.content_sha256, right.content_sha256);
    }

    fn sample_input<'a>(
        messages: &'a [FrozenProviderMessage],
        parameters_json: &'a str,
    ) -> FreezeProviderInput<'a> {
        FreezeProviderInput {
            id: INPUT,
            attempt_id: ATTEMPT,
            run_id: RUN,
            provider_profile_id: PROVIDER,
            model: "example-model",
            messages,
            parameters_json,
            created_at_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn rejects_dispatch_scope_mismatch() {
        let input = sample();
        let request = StartPreparedAttemptRequest {
            attempt_id: "attempt_ffffffffffffffffffffffffffffffff".into(),
            frozen_provider_input_id: INPUT.into(),
        };
        let error = input
            .assert_dispatch_scope(&request)
            .expect_err("foreign attempt must be rejected");
        assert_eq!(error.code, "prepared_input_scope_conflict");
    }

    #[test]
    fn rejects_tampered_hash() {
        let mut input = sample();
        input.parameters_json = "{\"temperature\":0.9}".into();
        let error = input.validate().expect_err("tampering must be detected");
        assert_eq!(error.code, "prepared_input_integrity_failed");
    }

    #[test]
    fn rejects_non_object_parameters() {
        let messages = vec![FrozenProviderMessage {
            role: "user".into(),
            content: "Hello".into(),
        }];
        let error = FrozenProviderInput::freeze(FreezeProviderInput {
            parameters_json: "[]",
            messages: &messages,
            ..sample_input(&messages, "{}")
        })
        .expect_err("array parameters must be rejected");
        assert_eq!(error.code, "invalid_input");
    }

    #[test]
    fn rejects_unknown_message_roles() {
        let messages = [FrozenProviderMessage {
            role: "function".into(),
            content: "bad".into(),
        }];
        let error = FrozenProviderInput::freeze(FreezeProviderInput {
            messages: &messages,
            ..sample_input(&messages, "{}")
        })
        .expect_err("unknown role must fail closed");
        assert_eq!(error.code, "invalid_input");
    }

    #[test]
    fn rejects_control_characters() {
        let messages = [FrozenProviderMessage {
            role: "user".into(),
            content: "bad\0text".into(),
        }];
        let error = FrozenProviderInput::freeze(FreezeProviderInput {
            messages: &messages,
            ..sample_input(&messages, "{}")
        })
        .expect_err("control characters must fail closed");
        assert_eq!(error.code, "invalid_input");
    }

    #[test]
    fn preserves_multiline_and_tabbed_message_content() {
        let content = "fn main() {\n\tprintln!(\"hello\");\n}\r\n";
        let messages = [FrozenProviderMessage {
            role: "user".into(),
            content: content.into(),
        }];
        let input = FrozenProviderInput::freeze(sample_input(&messages, "{}"))
            .expect("multiline code should be accepted");
        assert_eq!(input.messages[0].content, content);
        input
            .validate()
            .expect("multiline frozen input should validate");
    }

    #[test]
    fn validates_request_shape_before_storage_lookup() {
        let request = StartPreparedAttemptRequest {
            attempt_id: "run_not_an_attempt".into(),
            frozen_provider_input_id: INPUT.into(),
        };
        let error = request.validate().expect_err("wrong prefix must fail");
        assert_eq!(error.code, "invalid_input");
    }
}
