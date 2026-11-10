//! Deterministic, redacted portable-bundle envelopes.
//!
//! The native host owns the eventual project/database export path, but the
//! envelope format is deliberately independent from SQLite and provider
//! adapters.  Callers provide already-authorized metadata sections; this
//! module canonicalizes them, strips secret-shaped fields, and verifies the
//! resulting bytes before a command is allowed to write or import anything.

use std::{collections::BTreeMap, fmt};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const PORTABLE_BUNDLE_SCHEMA: &str = "omnia.portable-bundle.v1";
pub const PORTABLE_BUNDLE_VERSION: u16 = 1;
pub const PORTABLE_BUNDLE_MAX_BYTES: usize = 32 * 1024 * 1024;
pub const PORTABLE_BUNDLE_MAX_SECTIONS: usize = 128;
pub const PORTABLE_BUNDLE_MAX_SECTION_BYTES: usize = 16 * 1024 * 1024;

const SHA256_ALGORITHM: &str = "sha256";
const REDACTED_VALUE: &str = "[redacted]";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortableBundleError {
    EmptyBundle,
    InvalidSchema,
    InvalidVersion,
    InvalidCreatedAt,
    TooManySections,
    TooManyBytes,
    SectionTooLarge(String),
    InvalidSectionId(String),
    DuplicateSectionId(String),
    InvalidSectionKind(String),
    InvalidBoundary,
    InvalidAlgorithm,
    InvalidDigest(String),
    MalformedJson(String),
    NonCanonicalJson,
}

impl fmt::Display for PortableBundleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyBundle => formatter.write_str("portable bundle is empty"),
            Self::InvalidSchema => formatter.write_str("unsupported portable bundle schema"),
            Self::InvalidVersion => formatter.write_str("unsupported portable bundle version"),
            Self::InvalidCreatedAt => formatter.write_str("portable bundle createdAt is missing"),
            Self::TooManySections => {
                formatter.write_str("portable bundle contains too many sections")
            }
            Self::TooManyBytes => formatter.write_str("portable bundle exceeds the 32 MiB limit"),
            Self::SectionTooLarge(id) => write!(
                formatter,
                "portable bundle section {id} exceeds the 16 MiB limit"
            ),
            Self::InvalidSectionId(id) => {
                write!(formatter, "portable bundle section id is unsafe: {id}")
            }
            Self::DuplicateSectionId(id) => write!(
                formatter,
                "portable bundle contains duplicate section id: {id}"
            ),
            Self::InvalidSectionKind(kind) => {
                write!(formatter, "portable bundle section kind is invalid: {kind}")
            }
            Self::InvalidBoundary => {
                formatter.write_str("portable bundle boundary flags are invalid")
            }
            Self::InvalidAlgorithm => {
                formatter.write_str("portable bundle uses an unsupported digest algorithm")
            }
            Self::InvalidDigest(field) => {
                write!(formatter, "portable bundle digest is invalid: {field}")
            }
            Self::MalformedJson(message) => {
                write!(formatter, "portable bundle JSON is malformed: {message}")
            }
            Self::NonCanonicalJson => formatter.write_str("portable bundle JSON is not canonical"),
        }
    }
}

impl std::error::Error for PortableBundleError {}

/// A section supplied by an export adapter.  `payload` must be metadata or a
/// redacted content projection; this module never reads files or credentials.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortableBundleSectionInput {
    pub id: String,
    pub kind: String,
    pub payload: Value,
}

/// The on-disk section representation.  `byteLength` and `sha256` cover the
/// canonical UTF-8 JSON bytes of `payload` after secret-field redaction.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortableBundleSection {
    pub id: String,
    pub kind: String,
    pub payload: Value,
    pub byte_length: usize,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableBundleIntegrity {
    pub algorithm: String,
    pub manifest_sha256: String,
    pub section_count: usize,
    pub payload_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableBundleBoundary {
    pub secrets_excluded: bool,
    pub provider_requests: bool,
    pub native_writes: bool,
    pub source_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortableBundle {
    pub schema: String,
    pub version: u16,
    pub created_at: String,
    pub sections: Vec<PortableBundleSection>,
    pub integrity: PortableBundleIntegrity,
    pub boundary: PortableBundleBoundary,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PortableBundleInput {
    pub created_at: String,
    pub sections: Vec<PortableBundleSectionInput>,
    pub source_revision: Option<String>,
}

/// Build a redacted bundle.  Section ordering is normalized by `id`, so two
/// adapters that enumerate the same records in different order produce the
/// same bytes and manifest hash.
pub fn build_portable_bundle(
    input: PortableBundleInput,
) -> Result<PortableBundle, PortableBundleError> {
    if input.created_at.trim().is_empty() {
        return Err(PortableBundleError::InvalidCreatedAt);
    }
    if input.sections.is_empty() {
        return Err(PortableBundleError::EmptyBundle);
    }
    if input.sections.len() > PORTABLE_BUNDLE_MAX_SECTIONS {
        return Err(PortableBundleError::TooManySections);
    }

    let mut sections = Vec::with_capacity(input.sections.len());
    for section in input.sections {
        validate_section_id(&section.id)?;
        validate_section_kind(&section.kind)?;
        let payload = redact_secrets(canonicalize_json(section.payload));
        let payload_bytes = canonical_json_bytes(&payload);
        if payload_bytes.len() > PORTABLE_BUNDLE_MAX_SECTION_BYTES {
            return Err(PortableBundleError::SectionTooLarge(section.id));
        }
        sections.push(PortableBundleSection {
            id: section.id,
            kind: section.kind,
            payload,
            byte_length: payload_bytes.len(),
            sha256: sha256_hex(&payload_bytes),
        });
    }

    sections.sort_by(|left, right| left.id.cmp(&right.id));
    for pair in sections.windows(2) {
        if pair[0].id == pair[1].id {
            return Err(PortableBundleError::DuplicateSectionId(pair[0].id.clone()));
        }
    }

    let payload_bytes: usize = sections.iter().map(|section| section.byte_length).sum();
    let manifest_sha256 = manifest_hash(
        PORTABLE_BUNDLE_SCHEMA,
        PORTABLE_BUNDLE_VERSION,
        &input.created_at,
        &sections,
    );
    let section_count = sections.len();
    let bundle = PortableBundle {
        schema: PORTABLE_BUNDLE_SCHEMA.to_string(),
        version: PORTABLE_BUNDLE_VERSION,
        created_at: input.created_at,
        sections,
        integrity: PortableBundleIntegrity {
            algorithm: SHA256_ALGORITHM.to_string(),
            manifest_sha256,
            section_count,
            payload_bytes,
        },
        boundary: PortableBundleBoundary {
            secrets_excluded: true,
            provider_requests: false,
            native_writes: false,
            source_revision: input.source_revision,
        },
    };

    validate_portable_bundle(&bundle)?;
    if encode_portable_bundle(&bundle).len() > PORTABLE_BUNDLE_MAX_BYTES {
        return Err(PortableBundleError::TooManyBytes);
    }
    Ok(bundle)
}

/// Encode a bundle with sorted object keys and no insignificant whitespace.
pub fn encode_portable_bundle(bundle: &PortableBundle) -> Vec<u8> {
    canonical_json_bytes(&canonicalize_json(
        serde_json::to_value(bundle).expect("bundle is serializable"),
    ))
}

/// Parse and fully verify an encoded bundle before exposing its sections.
pub fn decode_portable_bundle(bytes: &[u8]) -> Result<PortableBundle, PortableBundleError> {
    if bytes.is_empty() {
        return Err(PortableBundleError::EmptyBundle);
    }
    if bytes.len() > PORTABLE_BUNDLE_MAX_BYTES {
        return Err(PortableBundleError::TooManyBytes);
    }
    let bundle: PortableBundle = serde_json::from_slice(bytes)
        .map_err(|error| PortableBundleError::MalformedJson(error.to_string()))?;
    validate_portable_bundle(&bundle)?;
    if encode_portable_bundle(&bundle) != bytes {
        return Err(PortableBundleError::NonCanonicalJson);
    }
    Ok(bundle)
}

/// Validate section hashes, the manifest hash, and the non-secret boundary.
pub fn validate_portable_bundle(bundle: &PortableBundle) -> Result<(), PortableBundleError> {
    if bundle.schema != PORTABLE_BUNDLE_SCHEMA {
        return Err(PortableBundleError::InvalidSchema);
    }
    if bundle.version != PORTABLE_BUNDLE_VERSION {
        return Err(PortableBundleError::InvalidVersion);
    }
    if bundle.created_at.trim().is_empty() {
        return Err(PortableBundleError::InvalidCreatedAt);
    }
    if bundle.sections.is_empty() {
        return Err(PortableBundleError::EmptyBundle);
    }
    if bundle.sections.len() > PORTABLE_BUNDLE_MAX_SECTIONS {
        return Err(PortableBundleError::TooManySections);
    }
    if bundle.integrity.algorithm != SHA256_ALGORITHM {
        return Err(PortableBundleError::InvalidAlgorithm);
    }
    if !bundle.boundary.secrets_excluded
        || bundle.boundary.provider_requests
        || bundle.boundary.native_writes
    {
        return Err(PortableBundleError::InvalidBoundary);
    }

    let mut payload_bytes = 0usize;
    for (index, section) in bundle.sections.iter().enumerate() {
        validate_section_id(&section.id)?;
        validate_section_kind(&section.kind)?;
        if index > 0 && bundle.sections[index - 1].id >= section.id {
            return Err(PortableBundleError::InvalidSectionId(section.id.clone()));
        }
        let payload = canonicalize_json(section.payload.clone());
        let encoded = canonical_json_bytes(&payload);
        if encoded.len() > PORTABLE_BUNDLE_MAX_SECTION_BYTES {
            return Err(PortableBundleError::SectionTooLarge(section.id.clone()));
        }
        if section.byte_length != encoded.len() {
            return Err(PortableBundleError::InvalidDigest(format!(
                "{}.byteLength",
                section.id
            )));
        }
        if section.sha256 != sha256_hex(&encoded) {
            return Err(PortableBundleError::InvalidDigest(format!(
                "{}.sha256",
                section.id
            )));
        }
        payload_bytes = payload_bytes
            .checked_add(encoded.len())
            .ok_or(PortableBundleError::TooManyBytes)?;
    }
    if bundle.integrity.section_count != bundle.sections.len()
        || bundle.integrity.payload_bytes != payload_bytes
    {
        return Err(PortableBundleError::InvalidDigest(
            "integrity summary".to_string(),
        ));
    }
    let expected_manifest = manifest_hash(
        &bundle.schema,
        bundle.version,
        &bundle.created_at,
        &bundle.sections,
    );
    if bundle.integrity.manifest_sha256 != expected_manifest {
        return Err(PortableBundleError::InvalidDigest(
            "integrity.manifestSha256".to_string(),
        ));
    }
    Ok(())
}

/// Recursively remove values whose object keys carry common credential names.
/// This is intentionally conservative: callers should still avoid passing raw
/// secrets, but accidental `apiKey`, `authorization`, and token fields cannot
/// cross into the generated bundle.
pub fn redact_secrets(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut redacted = Map::new();
            for (key, value) in object {
                if is_secret_key(&key) {
                    redacted.insert(key, Value::String(REDACTED_VALUE.to_string()));
                } else {
                    redacted.insert(key, redact_secrets(value));
                }
            }
            Value::Object(redacted)
        }
        Value::Array(values) => Value::Array(values.into_iter().map(redact_secrets).collect()),
        other => other,
    }
}

fn is_secret_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    [
        "accesskey",
        "accesstoken",
        "apikey",
        "authtoken",
        "authorization",
        "bearer",
        "clientsecret",
        "credential",
        "password",
        "privatekey",
        "refreshtoken",
        "secret",
        "secretkey",
        "sessiontoken",
        "webhooksecret",
    ]
    .iter()
    .any(|needle| normalized == *needle || normalized.contains(needle))
}

fn validate_section_id(id: &str) -> Result<(), PortableBundleError> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
        && !id.starts_with('.')
        && !id.ends_with('.')
        && !id.contains("..")
        && !id.contains("/")
        && !id.contains('\\');
    if valid {
        Ok(())
    } else {
        Err(PortableBundleError::InvalidSectionId(id.to_string()))
    }
}

fn validate_section_kind(kind: &str) -> Result<(), PortableBundleError> {
    let valid = !kind.is_empty()
        && kind.len() <= 64
        && kind.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        });
    if valid {
        Ok(())
    } else {
        Err(PortableBundleError::InvalidSectionKind(kind.to_string()))
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn manifest_hash(
    schema: &str,
    version: u16,
    created_at: &str,
    sections: &[PortableBundleSection],
) -> String {
    let manifest = serde_json::json!({
        "createdAt": created_at,
        "schema": schema,
        "sections": sections.iter().map(|section| serde_json::json!({
            "byteLength": section.byte_length,
            "id": section.id,
            "kind": section.kind,
            "sha256": section.sha256,
        })).collect::<Vec<_>>(),
        "version": version,
    });
    sha256_hex(&canonical_json_bytes(&canonicalize_json(manifest)))
}

fn canonical_json_bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).expect("canonical JSON value is serializable")
}

fn canonicalize_json(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let sorted = object
                .into_iter()
                .map(|(key, value)| (key, canonicalize_json(value)))
                .collect::<BTreeMap<_, _>>();
            let mut map = Map::new();
            for (key, value) in sorted {
                map.insert(key, value);
            }
            Value::Object(map)
        }
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize_json).collect()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(sections: Vec<PortableBundleSectionInput>) -> PortableBundleInput {
        PortableBundleInput {
            created_at: "2026-10-17T00:00:00Z".to_string(),
            sections,
            source_revision: Some("test-revision".to_string()),
        }
    }

    #[test]
    fn builds_deterministic_redacted_bundle() {
        let first = build_portable_bundle(input(vec![
            PortableBundleSectionInput { id: "projects".to_string(), kind: "project".to_string(), payload: serde_json::json!({"z":1,"apiKey":"do-not-export","nested":{"access_token":"nope","ok":true}}) },
            PortableBundleSectionInput { id: "conversations".to_string(), kind: "conversation".to_string(), payload: serde_json::json!({"title":"hello"}) },
        ])).unwrap();
        let second = build_portable_bundle(input(vec![
            PortableBundleSectionInput { id: "conversations".to_string(), kind: "conversation".to_string(), payload: serde_json::json!({"title":"hello"}) },
            PortableBundleSectionInput { id: "projects".to_string(), kind: "project".to_string(), payload: serde_json::json!({"nested":{"ok":true,"access_token":"nope"},"apiKey":"do-not-export","z":1}) },
        ])).unwrap();
        assert_eq!(
            encode_portable_bundle(&first),
            encode_portable_bundle(&second)
        );
        assert_eq!(first.sections[0].id, "conversations");
        assert_eq!(first.sections[1].payload["apiKey"], REDACTED_VALUE);
        assert_eq!(
            first.sections[1].payload["nested"]["access_token"],
            REDACTED_VALUE
        );
    }

    #[test]
    fn round_trip_rejects_tampering_and_noncanonical_json() {
        let bundle = build_portable_bundle(input(vec![PortableBundleSectionInput {
            id: "projects".to_string(),
            kind: "project".to_string(),
            payload: serde_json::json!({"name":"Omnia"}),
        }]))
        .unwrap();
        let encoded = encode_portable_bundle(&bundle);
        assert_eq!(decode_portable_bundle(&encoded).unwrap(), bundle);

        let mut tampered = bundle.clone();
        tampered.sections[0].payload["name"] = Value::String("changed".to_string());
        assert!(matches!(
            validate_portable_bundle(&tampered),
            Err(PortableBundleError::InvalidDigest(_))
        ));

        let pretty = serde_json::to_vec_pretty(&bundle).unwrap();
        assert!(matches!(
            decode_portable_bundle(&pretty),
            Err(PortableBundleError::NonCanonicalJson)
        ));
    }

    #[test]
    fn rejects_unsafe_or_duplicate_section_ids() {
        let unsafe_section = build_portable_bundle(input(vec![PortableBundleSectionInput {
            id: "../secrets".to_string(),
            kind: "project".to_string(),
            payload: Value::Null,
        }]));
        assert!(matches!(
            unsafe_section,
            Err(PortableBundleError::InvalidSectionId(_))
        ));

        let duplicate = build_portable_bundle(input(vec![
            PortableBundleSectionInput {
                id: "projects".to_string(),
                kind: "project".to_string(),
                payload: Value::Null,
            },
            PortableBundleSectionInput {
                id: "projects".to_string(),
                kind: "project".to_string(),
                payload: Value::Null,
            },
        ]));
        assert!(matches!(
            duplicate,
            Err(PortableBundleError::DuplicateSectionId(_))
        ));
    }
}
