//! Immutable, secret-free provider transport definitions.
//!
//! A prepared run must not silently inherit later edits to its provider
//! profile. This contract freezes every native transport and security field
//! that can change the request destination, authentication binding, headers,
//! or egress authority. The opaque credential handle is included, but secret
//! bytes are deliberately outside this type and its content hash.

use std::net::IpAddr;

use serde::Serialize;
use sha2::{Digest, Sha256};
use url::{Host, Url};

use crate::error::{NativeError, NativeResult};

pub const FROZEN_PROVIDER_DEFINITION_SCHEMA_VERSION: u32 = 1;
pub const NATIVE_PROVIDER_ADAPTER_REVISION: &str = "omnia-native-provider-adapters-v1";

const PROVIDER_PROFILE_PREFIX: &str = "provider_";
const PROVIDER_SECRET_PREFIX: &str = "provider_secret_";
const MAX_PROVIDER_TYPE_BYTES: usize = 80;
const MAX_AUTH_SCHEME_BYTES: usize = 40;
const MAX_BASE_URL_BYTES: usize = 4 * 1024;
const MAX_HEADER_VALUE_BYTES: usize = 240;
const MAX_ADAPTER_REVISION_BYTES: usize = 160;

/// Immutable provider transport and security material selected at preparation.
///
/// `credential_ref` is an opaque Windows credential-store handle. It is not a
/// provider credential and must never be replaced by secret bytes in storage,
/// logs, renderer receipts, or run-journal payloads.
#[derive(Clone, PartialEq, Eq)]
pub struct FrozenProviderDefinition {
    pub schema_version: u32,
    pub provider_profile_id: String,
    pub provider_type: String,
    pub normalized_base_url: String,
    pub auth_scheme: String,
    pub organization_id: Option<String>,
    pub remote_project_id: Option<String>,
    pub credential_ref: Option<String>,
    pub local_network_grant: bool,
    pub adapter_revision: String,
    pub definition_sha256: String,
}

/// Redacted native-only debug projection.
///
/// The provider credential reference is an opaque handle into the protected
/// secret store.  It is intentionally represented only as a boolean here so
/// accidental `{:?}` logging cannot disclose the handle or make it look like
/// a safe renderer-facing identifier.  The type also deliberately does not
/// implement `Serialize`/`Deserialize`; only explicit receipt DTOs may cross
/// the Tauri boundary.
impl std::fmt::Debug for FrozenProviderDefinition {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FrozenProviderDefinition")
            .field("schema_version", &self.schema_version)
            .field("provider_profile_id", &self.provider_profile_id)
            .field("provider_type", &self.provider_type)
            .field("normalized_base_url", &self.normalized_base_url)
            .field("auth_scheme", &self.auth_scheme)
            .field("organization_id", &self.organization_id)
            .field("remote_project_id", &self.remote_project_id)
            .field("credential_bound", &self.credential_ref.is_some())
            .field("local_network_grant", &self.local_network_grant)
            .field("adapter_revision", &self.adapter_revision)
            .field("definition_sha256", &self.definition_sha256)
            .finish()
    }
}

/// Borrowed native-owned provider profile material used while preparing a run
/// or reconstructing the current live definition immediately before dispatch.
#[derive(Clone, Copy)]
pub struct FreezeProviderDefinition<'a> {
    pub provider_profile_id: &'a str,
    pub provider_type: &'a str,
    pub normalized_base_url: &'a str,
    pub auth_scheme: &'a str,
    pub organization_id: Option<&'a str>,
    pub remote_project_id: Option<&'a str>,
    pub credential_ref: Option<&'a str>,
    pub local_network_grant: bool,
    pub adapter_revision: &'a str,
}

/// Redacted debug projection for the borrowed provider definition.
///
/// This value is commonly assembled directly from a provider-profile row and
/// can therefore contain the opaque credential-store reference.  Even though
/// the reference is not a secret byte string, emitting it in a debug trace
/// would disclose a reusable handle that must stay native-owned.  Keep the
/// same redaction policy as [`FrozenProviderDefinition`]: report only whether
/// a credential is bound, never the handle itself.
impl std::fmt::Debug for FreezeProviderDefinition<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FreezeProviderDefinition")
            .field("provider_profile_id", &self.provider_profile_id)
            .field("provider_type", &self.provider_type)
            .field("normalized_base_url", &self.normalized_base_url)
            .field("auth_scheme", &self.auth_scheme)
            .field("organization_id", &self.organization_id)
            .field("remote_project_id", &self.remote_project_id)
            .field("credential_bound", &self.credential_ref.is_some())
            .field("local_network_grant", &self.local_network_grant)
            .field("adapter_revision", &self.adapter_revision)
            .finish()
    }
}

impl FrozenProviderDefinition {
    /// Canonicalizes and freezes a provider definition. The fingerprint covers
    /// every field in this type except the fingerprint itself.
    pub fn freeze(input: FreezeProviderDefinition<'_>) -> NativeResult<Self> {
        let provider_profile_id = canonical_opaque_id(
            "providerProfileId",
            input.provider_profile_id,
            PROVIDER_PROFILE_PREFIX,
        )?;
        let provider_type = canonical_snake_identifier(
            "providerType",
            input.provider_type,
            MAX_PROVIDER_TYPE_BYTES,
        )?;
        let auth_scheme =
            canonical_snake_identifier("authScheme", input.auth_scheme, MAX_AUTH_SCHEME_BYTES)?;
        validate_adapter_binding(&provider_type, &auth_scheme)?;

        let normalized_base_url =
            canonical_base_url(input.normalized_base_url, input.local_network_grant)?;
        let organization_id = canonical_header_value("organizationId", input.organization_id)?;
        let remote_project_id = canonical_header_value("remoteProjectId", input.remote_project_id)?;
        let credential_ref = canonical_credential_ref(input.credential_ref, &auth_scheme)?;
        let adapter_revision = canonical_bounded_text(
            "adapterRevision",
            input.adapter_revision,
            MAX_ADAPTER_REVISION_BYTES,
        )?;

        let definition_sha256 = hash_material(DefinitionMaterial {
            schema_version: FROZEN_PROVIDER_DEFINITION_SCHEMA_VERSION,
            provider_profile_id: &provider_profile_id,
            provider_type: &provider_type,
            normalized_base_url: &normalized_base_url,
            auth_scheme: &auth_scheme,
            organization_id: organization_id.as_deref(),
            remote_project_id: remote_project_id.as_deref(),
            credential_ref: credential_ref.as_deref(),
            local_network_grant: input.local_network_grant,
            adapter_revision: &adapter_revision,
        })?;

        Ok(Self {
            schema_version: FROZEN_PROVIDER_DEFINITION_SCHEMA_VERSION,
            provider_profile_id,
            provider_type,
            normalized_base_url,
            auth_scheme,
            organization_id,
            remote_project_id,
            credential_ref,
            local_network_grant: input.local_network_grant,
            adapter_revision,
            definition_sha256,
        })
    }

    /// Revalidates a definition loaded from durable storage. Non-canonical
    /// fields and a mismatched fingerprint are both storage-integrity failures.
    pub fn validate(&self) -> NativeResult<()> {
        if self.schema_version != FROZEN_PROVIDER_DEFINITION_SCHEMA_VERSION {
            return Err(NativeError::new(
                "unsupported_schema",
                "The frozen provider definition schema version is unsupported",
            ));
        }

        let rebuilt = Self::freeze(FreezeProviderDefinition {
            provider_profile_id: &self.provider_profile_id,
            provider_type: &self.provider_type,
            normalized_base_url: &self.normalized_base_url,
            auth_scheme: &self.auth_scheme,
            organization_id: self.organization_id.as_deref(),
            remote_project_id: self.remote_project_id.as_deref(),
            credential_ref: self.credential_ref.as_deref(),
            local_network_grant: self.local_network_grant,
            adapter_revision: &self.adapter_revision,
        })
        .map_err(|_| provider_definition_integrity_failed())?;

        if rebuilt != *self {
            return Err(provider_definition_integrity_failed());
        }
        Ok(())
    }

    #[cfg(test)]
    /// Requires the current live provider profile to reconstruct to the exact
    /// definition selected during preparation.
    ///
    /// Call this before DNS resolution, credential-store access, request
    /// construction, or HTTP dispatch. Live-profile validation errors are
    /// intentionally collapsed to the same generic drift error so renderer
    /// diagnostics cannot reveal which private endpoint or credential handle
    /// component changed.
    pub fn assert_live_match(&self, live: FreezeProviderDefinition<'_>) -> NativeResult<()> {
        self.validate()?;
        let live = Self::freeze(live).map_err(|_| provider_definition_changed())?;
        if live != *self {
            return Err(provider_definition_changed());
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DefinitionMaterial<'a> {
    schema_version: u32,
    provider_profile_id: &'a str,
    provider_type: &'a str,
    normalized_base_url: &'a str,
    auth_scheme: &'a str,
    organization_id: Option<&'a str>,
    remote_project_id: Option<&'a str>,
    credential_ref: Option<&'a str>,
    local_network_grant: bool,
    adapter_revision: &'a str,
}

fn hash_material(material: DefinitionMaterial<'_>) -> NativeResult<String> {
    let bytes =
        serde_json::to_vec(&material).map_err(|_| provider_definition_integrity_failed())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn canonical_opaque_id(field: &'static str, value: &str, prefix: &str) -> NativeResult<String> {
    let suffix = value.strip_prefix(prefix);
    let valid = suffix.is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    });
    if !valid {
        return Err(NativeError::invalid(
            field,
            format!("must be a canonical opaque identifier beginning with {prefix:?}"),
        ));
    }
    Ok(value.to_owned())
}

fn canonical_snake_identifier(
    field: &'static str,
    value: &str,
    max_bytes: usize,
) -> NativeResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max_bytes {
        return Err(NativeError::invalid(
            field,
            "is empty or exceeds the provider-definition safety limit",
        ));
    }

    let mut normalized = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            normalized.push(character.to_ascii_lowercase());
        } else if character == '-' || character == '_' || character.is_ascii_whitespace() {
            if !normalized.is_empty() && !normalized.ends_with('_') {
                normalized.push('_');
            }
        } else {
            return Err(NativeError::invalid(
                field,
                "must contain only ASCII letters, numbers, or separators",
            ));
        }
    }
    while normalized.ends_with('_') {
        normalized.pop();
    }
    if normalized.is_empty() || normalized.len() > max_bytes {
        return Err(NativeError::invalid(
            field,
            "does not contain a bounded identifier",
        ));
    }
    Ok(normalized)
}

fn validate_adapter_binding(provider_type: &str, auth_scheme: &str) -> NativeResult<()> {
    let supported = match provider_type {
        "openai" | "deepseek" | "openai_compatible" => {
            matches!(auth_scheme, "bearer" | "api_key_header")
        }
        // Anthropic accepts both its explicit API-key header and the bearer
        // token form used by Claude Code / delegated auth flows. Keep the
        // selected scheme frozen in the provider definition so a prepared
        // attempt cannot silently switch authentication semantics.
        "anthropic" => matches!(auth_scheme, "api_key_header" | "bearer"),
        "gemini" => auth_scheme == "api_key_header",
        "local" => matches!(auth_scheme, "none" | "bearer" | "api_key_header"),
        _ => {
            return Err(NativeError::new(
                "unsupported_provider_definition",
                "The provider definition has no installed native adapter",
            ))
        }
    };
    if !supported {
        return Err(NativeError::new(
            "unsupported_provider_definition",
            "The provider authentication binding is unsupported by its native adapter",
        ));
    }
    Ok(())
}

fn canonical_base_url(value: &str, local_network_grant: bool) -> NativeResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_BASE_URL_BYTES {
        return Err(NativeError::invalid(
            "baseUrl",
            "is empty or exceeds the provider-definition safety limit",
        ));
    }
    let url = Url::parse(value)
        .map_err(|_| NativeError::invalid("baseUrl", "must be a valid HTTP or HTTPS URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(NativeError::invalid("baseUrl", "must use HTTP or HTTPS"));
    }
    if url.username() != "" || url.password().is_some() {
        return Err(NativeError::invalid(
            "baseUrl",
            "cannot contain embedded credentials",
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(NativeError::invalid(
            "baseUrl",
            "cannot contain a query or fragment",
        ));
    }

    let host = url
        .host()
        .ok_or_else(|| NativeError::invalid("baseUrl", "must include a hostname"))?;
    if literal_host_is_always_blocked(&host) {
        return Err(NativeError::new(
            "provider_destination_blocked",
            "The provider endpoint is not an allowed network destination",
        ));
    }
    let visibly_local = visibly_local_host(&host);
    if visibly_local && !local_network_grant {
        return Err(NativeError::new(
            "local_network_permission_required",
            "Local and private-network providers require an explicit local-network grant",
        ));
    }
    if url.scheme() == "http" && !visibly_local {
        return Err(NativeError::new(
            "insecure_provider_transport",
            "Internet providers must use HTTPS",
        ));
    }

    // `Url` canonicalizes scheme, host, default ports, IDNs, and percent
    // encoding. Provider endpoints are joined relative to a directory by the
    // native adapters, so trailing slash variants intentionally share one
    // transport definition.
    let normalized = url.to_string().trim_end_matches('/').to_owned();
    if normalized.is_empty() || normalized.len() > MAX_BASE_URL_BYTES {
        return Err(NativeError::invalid(
            "baseUrl",
            "could not be canonicalized within the safety limit",
        ));
    }
    Ok(normalized)
}

fn visibly_local_host(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => {
            domain.eq_ignore_ascii_case("localhost")
                || domain.to_ascii_lowercase().ends_with(".localhost")
        }
        Host::Ipv4(address) => is_private_or_local(IpAddr::V4(*address)),
        Host::Ipv6(address) => is_private_or_local(IpAddr::V6(*address)),
    }
}

fn literal_host_is_always_blocked(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(_) => false,
        Host::Ipv4(address) => is_always_blocked_destination(IpAddr::V4(*address)),
        Host::Ipv6(address) => is_always_blocked_destination(IpAddr::V6(*address)),
    }
}

fn is_private_or_local(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || address.is_broadcast()
                || address.is_documentation()
                || address.is_multicast()
                || address.is_unspecified()
                || address.octets()[0] == 0
                || address.octets()[0] >= 240
                || matches!(address.octets(), [100, second, _, _] if (64..=127).contains(&second))
                || matches!(address.octets(), [192, 0, 0, _])
                || matches!(address.octets(), [198, second, _, _] if second == 18 || second == 19)
        }
        IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_multicast()
                || address.is_unspecified()
                || (address.segments()[0] & 0xfe00) == 0xfc00
                || (address.segments()[0] & 0xffc0) == 0xfe80
                || (address.segments()[0] == 0x2001 && address.segments()[1] == 0x0db8)
                || address
                    .to_ipv4_mapped()
                    .is_some_and(|address| is_private_or_local(IpAddr::V4(address)))
        }
    }
}

fn is_always_blocked_destination(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_link_local()
                || address.is_broadcast()
                || address.is_multicast()
                || address.is_unspecified()
                || address.octets()[0] == 0
                || address.octets()[0] >= 240
        }
        IpAddr::V6(address) => {
            address.is_multicast()
                || address.is_unspecified()
                || (address.segments()[0] & 0xffc0) == 0xfe80
                || address
                    .to_ipv4_mapped()
                    .is_some_and(|address| is_always_blocked_destination(IpAddr::V4(address)))
        }
    }
}

fn canonical_header_value(
    field: &'static str,
    value: Option<&str>,
) -> NativeResult<Option<String>> {
    value
        .map(|value| canonical_optional_bounded_text(field, value, MAX_HEADER_VALUE_BYTES))
        .transpose()
        .map(Option::flatten)
}

fn canonical_optional_bounded_text(
    field: &'static str,
    value: &str,
    max_bytes: usize,
) -> NativeResult<Option<String>> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > max_bytes {
        return Err(NativeError::invalid(
            field,
            "exceeds the provider-definition safety limit",
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(NativeError::invalid(field, "contains a control character"));
    }
    Ok(Some(value.to_owned()))
}

fn canonical_bounded_text(
    field: &'static str,
    value: &str,
    max_bytes: usize,
) -> NativeResult<String> {
    canonical_optional_bounded_text(field, value, max_bytes)?
        .ok_or_else(|| NativeError::invalid(field, "cannot be empty"))
}

fn canonical_credential_ref(
    credential_ref: Option<&str>,
    auth_scheme: &str,
) -> NativeResult<Option<String>> {
    match (auth_scheme, credential_ref) {
        ("none", None) => Ok(None),
        ("none", Some(_)) => Err(NativeError::invalid(
            "credentialRef",
            "must be absent when provider authentication is disabled",
        )),
        (_, Some(reference)) => {
            canonical_opaque_id("credentialRef", reference, PROVIDER_SECRET_PREFIX).map(Some)
        }
        (_, None) => Err(NativeError::new(
            "secret_missing",
            "The provider credential handle is missing",
        )),
    }
}

fn provider_definition_integrity_failed() -> NativeError {
    NativeError::new(
        "provider_definition_integrity_failed",
        "The frozen provider definition fingerprint does not match its canonical body",
    )
}

#[cfg(test)]
fn provider_definition_changed() -> NativeError {
    NativeError::new(
        "provider_definition_changed",
        "The provider connection changed after this run was prepared; prepare the run again",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROVIDER: &str = "provider_0123456789abcdef0123456789abcdef";
    const CREDENTIAL: &str = "provider_secret_0123456789abcdef0123456789abcdef";
    const OTHER_CREDENTIAL: &str = "provider_secret_fedcba9876543210fedcba9876543210";

    fn sample_input() -> FreezeProviderDefinition<'static> {
        FreezeProviderDefinition {
            provider_profile_id: PROVIDER,
            provider_type: "openai_compatible",
            normalized_base_url: "https://api.example.com/v1",
            auth_scheme: "bearer",
            organization_id: Some("org_omnia"),
            remote_project_id: Some("project_omnia"),
            credential_ref: Some(CREDENTIAL),
            local_network_grant: false,
            adapter_revision: NATIVE_PROVIDER_ADAPTER_REVISION,
        }
    }

    fn sample() -> FrozenProviderDefinition {
        FrozenProviderDefinition::freeze(sample_input()).expect("sample definition should freeze")
    }

    #[test]
    fn definition_is_canonical_deterministic_and_secret_free() {
        let canonical = sample();
        let variant = FrozenProviderDefinition::freeze(FreezeProviderDefinition {
            provider_type: " OpenAI-Compatible ",
            normalized_base_url: "HTTPS://API.EXAMPLE.COM:443/v1/",
            auth_scheme: " Bearer ",
            organization_id: Some(" org_omnia "),
            remote_project_id: Some(" project_omnia "),
            adapter_revision: " omnia-native-provider-adapters-v1 ",
            ..sample_input()
        })
        .expect("canonical variants should freeze");

        assert_eq!(variant, canonical);
        assert_eq!(canonical.provider_type, "openai_compatible");
        assert_eq!(canonical.auth_scheme, "bearer");
        assert_eq!(canonical.normalized_base_url, "https://api.example.com/v1");
        assert_eq!(canonical.definition_sha256.len(), 64);
        assert!(canonical
            .definition_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));

        let debug = format!("{canonical:?}");
        assert!(!debug.contains(CREDENTIAL));
        assert!(debug.contains("credential_bound: true"));
        assert!(!debug.contains("secretBytes"));
        assert!(!debug.contains("apiKey"));
    }

    #[test]
    fn destination_change_invalidates_definition() {
        let error = sample()
            .assert_live_match(FreezeProviderDefinition {
                normalized_base_url: "https://api.example.com/v2",
                ..sample_input()
            })
            .expect_err("destination drift must fail closed");
        assert_eq!(error.code, "provider_definition_changed");
    }

    #[test]
    fn auth_scheme_change_invalidates_definition() {
        let error = sample()
            .assert_live_match(FreezeProviderDefinition {
                auth_scheme: "api-key-header",
                ..sample_input()
            })
            .expect_err("auth binding drift must fail closed");
        assert_eq!(error.code, "provider_definition_changed");
    }

    #[test]
    fn organization_or_project_header_change_invalidates_definition() {
        for live in [
            FreezeProviderDefinition {
                organization_id: Some("org_changed"),
                ..sample_input()
            },
            FreezeProviderDefinition {
                remote_project_id: Some("project_changed"),
                ..sample_input()
            },
        ] {
            let error = sample()
                .assert_live_match(live)
                .expect_err("header drift must fail closed");
            assert_eq!(error.code, "provider_definition_changed");
        }
    }

    #[test]
    fn credential_handle_change_invalidates_definition() {
        let error = sample()
            .assert_live_match(FreezeProviderDefinition {
                credential_ref: Some(OTHER_CREDENTIAL),
                ..sample_input()
            })
            .expect_err("credential revision drift must fail closed");
        assert_eq!(error.code, "provider_definition_changed");
    }

    #[test]
    fn egress_grant_change_invalidates_definition() {
        let error = sample()
            .assert_live_match(FreezeProviderDefinition {
                local_network_grant: true,
                ..sample_input()
            })
            .expect_err("egress-authority drift must fail closed");
        assert_eq!(error.code, "provider_definition_changed");
    }

    #[test]
    fn adapter_revision_change_invalidates_definition() {
        let error = sample()
            .assert_live_match(FreezeProviderDefinition {
                adapter_revision: "omnia-native-provider-adapters-v2",
                ..sample_input()
            })
            .expect_err("adapter revision drift must fail closed");
        assert_eq!(error.code, "provider_definition_changed");
    }

    #[test]
    fn malformed_credential_handle_is_rejected() {
        let error = FrozenProviderDefinition::freeze(FreezeProviderDefinition {
            credential_ref: Some("provider_secret_not-an-opaque-id"),
            ..sample_input()
        })
        .expect_err("malformed credential handles must fail closed");
        assert_eq!(error.code, "invalid_input");
        assert!(!error.message.contains("not-an-opaque-id"));
    }

    #[test]
    fn local_destination_without_grant_is_rejected() {
        let error = FrozenProviderDefinition::freeze(FreezeProviderDefinition {
            provider_type: "local",
            normalized_base_url: "http://127.0.0.1:11434/v1",
            auth_scheme: "none",
            credential_ref: None,
            local_network_grant: false,
            ..sample_input()
        })
        .expect_err("local destinations require explicit authority");
        assert_eq!(error.code, "local_network_permission_required");
    }

    #[test]
    fn stored_fingerprint_tampering_is_detected() {
        let mut definition = sample();
        definition.definition_sha256 = "0".repeat(64);
        let error = definition
            .validate()
            .expect_err("stored fingerprint tampering must be detected");
        assert_eq!(error.code, "provider_definition_integrity_failed");
    }

    #[test]
    fn unsupported_provider_definition_is_rejected() {
        for provider_type in ["custom_adapter", "azure_openai", "unknown"] {
            let error = FrozenProviderDefinition::freeze(FreezeProviderDefinition {
                provider_type,
                ..sample_input()
            })
            .expect_err("uninstalled provider definitions must fail closed");
            assert_eq!(error.code, "unsupported_provider_definition");
        }
    }

    #[test]
    fn anthropic_bearer_auth_definition_is_valid() {
        let definition = FrozenProviderDefinition::freeze(FreezeProviderDefinition {
            provider_type: "anthropic",
            normalized_base_url: "https://api.anthropic.com/v1",
            auth_scheme: "bearer",
            credential_ref: Some(CREDENTIAL),
            organization_id: None,
            remote_project_id: None,
            ..sample_input()
        })
        .expect("Anthropic bearer definitions should be supported");
        assert_eq!(definition.provider_type, "anthropic");
        assert_eq!(definition.auth_scheme, "bearer");
        definition
            .validate()
            .expect("the frozen bearer definition should revalidate");
    }

    #[test]
    fn anthropic_unsupported_auth_definition_still_fails_closed() {
        let error = FrozenProviderDefinition::freeze(FreezeProviderDefinition {
            provider_type: "anthropic",
            auth_scheme: "custom_header",
            ..sample_input()
        })
        .expect_err("custom Anthropic headers are not installed in the native adapter");
        assert_eq!(error.code, "unsupported_provider_definition");
    }

    #[test]
    fn public_http_and_embedded_url_authority_are_rejected() {
        for base_url in [
            "http://api.example.com/v1",
            "https://user:password@api.example.com/v1",
            "https://api.example.com/v1?token=unsafe",
            "https://api.example.com/v1#fragment",
        ] {
            assert!(FrozenProviderDefinition::freeze(FreezeProviderDefinition {
                normalized_base_url: base_url,
                ..sample_input()
            })
            .is_err());
        }
    }

    #[test]
    fn local_no_auth_definition_is_valid_with_grant() {
        let definition = FrozenProviderDefinition::freeze(FreezeProviderDefinition {
            provider_type: "local",
            normalized_base_url: "http://localhost:11434/v1/",
            auth_scheme: "none",
            credential_ref: None,
            local_network_grant: true,
            organization_id: None,
            remote_project_id: None,
            ..sample_input()
        })
        .expect("explicitly authorized local definition should freeze");
        assert_eq!(definition.normalized_base_url, "http://localhost:11434/v1");
        definition.validate().expect("definition should revalidate");
    }

    #[test]
    fn stored_noncanonical_body_is_rejected_even_with_a_canonical_hash() {
        let mut definition = sample();
        definition.provider_type = "OpenAI-Compatible".to_owned();
        let error = definition
            .validate()
            .expect_err("stored fields must remain canonical");
        assert_eq!(error.code, "provider_definition_integrity_failed");
    }

    #[test]
    fn live_validation_failures_are_reported_as_generic_definition_drift() {
        let error = sample()
            .assert_live_match(FreezeProviderDefinition {
                normalized_base_url: "https://private.invalid/v1?changed=true",
                credential_ref: Some("provider_secret_malformed"),
                ..sample_input()
            })
            .expect_err("invalid live material is still definition drift");
        assert_eq!(error.code, "provider_definition_changed");
        assert!(!error.message.contains("private.invalid"));
        assert!(!error.message.contains("credential"));
    }
}
