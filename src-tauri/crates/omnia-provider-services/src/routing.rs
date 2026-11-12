//! Native provider-profile mapping shared by independently rendered hosts.
//!
//! The caller owns profile authority, credential acquisition and frozen-dispatch
//! verification. This module neither opens storage nor starts an Agent/runtime.
//! Construction delegates to the existing policy-enforcing HTTP factory; it may
//! resolve DNS, but does not dispatch a provider inference request.

use std::sync::Arc;

pub use crate::dynamic_router::*;

use omnia_harness::{
    provider::{
        destination::{DestinationError, DestinationErrorClass},
        factory::{self, AdapterFamily, AuthScheme, FactoryError, ProviderSelection},
        record::RequestLog,
    },
    Provider,
};
use omnia_session_store::error::{NativeError, NativeResult, ProviderErrorClass};

/// Host-selected metadata. Deliberately not Debug or Serialize: endpoint and
/// routing identifiers are not diagnostic or renderer payloads.
pub struct ProviderProfileInput<'a> {
    pub provider_type: &'a str,
    pub base_url: &'a str,
    pub auth_scheme: &'a str,
    pub organization: Option<&'a str>,
    pub project: Option<&'a str>,
    pub enabled: bool,
    pub local_network_grant: bool,
}

/// Map the existing saved-profile vocabulary to installed adapters.
///
/// Preserve disabled-first, then family, then authentication validation. URL
/// and exact header validation remain the shared factory's responsibility.
pub fn provider_selection(input: ProviderProfileInput<'_>) -> NativeResult<ProviderSelection> {
    if !input.enabled {
        return Err(NativeError::new(
            "provider_disabled",
            "The selected provider is disabled",
        ));
    }
    let provider_type = normalize_identifier(input.provider_type);
    let family =
        match provider_type.as_str() {
            "openai" => AdapterFamily::OpenAiResponses,
            "deepseek" | "openai_compatible" | "local" => AdapterFamily::OpenAiChat,
            "anthropic" => AdapterFamily::Anthropic,
            "gemini" | "google" | "google_gemini" => AdapterFamily::Gemini,
            "azure" | "azure_openai" => return Err(family_error(
                "provider_not_available",
                "Azure OpenAI deployment and API-version routing are not available in this preview",
            )),
            "custom" | "custom_adapter" => {
                return Err(family_error(
                    "provider_not_available",
                    "Declarative custom adapters are not available in this preview",
                ))
            }
            _ => {
                return Err(family_error(
                    "unsupported_provider",
                    "This provider type has no installed native adapter",
                ))
            }
        };
    let auth = match normalize_identifier(input.auth_scheme).as_str() {
        "none" => AuthScheme::None,
        "bearer" => AuthScheme::Bearer,
        "api_key_header" => AuthScheme::ApiKeyHeader,
        _ => {
            return Err(NativeError::new(
                "unsupported_auth_scheme",
                "The provider authentication scheme is not supported by the agent harness",
            ))
        }
    };
    let routing_headers = matches!(provider_type.as_str(), "openai" | "openai_compatible");
    Ok(ProviderSelection {
        base_url: input.base_url.to_owned(),
        enabled: input.enabled,
        local_network_grant: input.local_network_grant,
        family,
        auth,
        organization: if routing_headers {
            input.organization.map(str::to_owned)
        } else {
            None
        },
        project: if routing_headers {
            input.project.map(str::to_owned)
        } else {
            None
        },
    })
}

/// Construct an installed adapter using the canonical native destination and
/// authentication policy. Success is adapter construction, not provider reach,
/// credential validity, authorization, or completed execution.
pub async fn build_provider(
    input: ProviderProfileInput<'_>,
    credential: Option<String>,
    request_log: Option<Arc<RequestLog>>,
) -> NativeResult<Arc<dyn Provider>> {
    factory::build_provider(provider_selection(input)?, credential, request_log)
        .await
        .map_err(|error| match error {
            FactoryError::Destination(error) => native_destination_error(error),
            FactoryError::MissingCredential => {
                NativeError::new("secret_missing", "The provider credential is missing")
            }
            FactoryError::InvalidHeader => NativeError::new(
                "invalid_provider_header",
                "The provider authentication or routing header is invalid",
            ),
        })
}

/// Preserve the host's static diagnostics, retryability and coarse origin.
pub fn native_destination_error(error: DestinationError) -> NativeError {
    let native = if error.retryable {
        NativeError::retryable(error.code, error.message)
    } else {
        NativeError::new(error.code, error.message)
    };
    match error.class {
        DestinationErrorClass::Dns => native.with_provider_error_class(ProviderErrorClass::Dns),
        DestinationErrorClass::Transport => {
            native.with_provider_error_class(ProviderErrorClass::Transport)
        }
        DestinationErrorClass::InvalidInput | DestinationErrorClass::Policy => native,
    }
}

fn normalize_identifier(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace(['-', ' '], "_")
}

fn family_error(code: &'static str, message: &'static str) -> NativeError {
    // The previous host path converted ProviderFailure::new through
    // native_provider_error. Preserve its metadata, including "not accepted".
    NativeError::new(code, message)
        .with_provider_metadata(None, None, Some("false"))
        .with_provider_error_class(ProviderErrorClass::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(provider_type: &str) -> ProviderProfileInput<'_> {
        ProviderProfileInput {
            provider_type,
            // Invalid by construction: the negative async cases must fail in
            // mapping/header/credential checks before destination validation.
            base_url: "not a valid provider URL",
            auth_scheme: "none",
            organization: Some("fixture-org"),
            project: Some("fixture-project"),
            enabled: true,
            local_network_grant: false,
        }
    }

    #[test]
    fn installed_family_matrix_and_normalized_aliases_match_existing_policy() {
        for (name, expected) in [
            ("openai", AdapterFamily::OpenAiResponses),
            (" OPENAI ", AdapterFamily::OpenAiResponses),
            ("deepseek", AdapterFamily::OpenAiChat),
            ("openai_compatible", AdapterFamily::OpenAiChat),
            ("OpenAI-Compatible", AdapterFamily::OpenAiChat),
            ("openai compatible", AdapterFamily::OpenAiChat),
            ("local", AdapterFamily::OpenAiChat),
            ("anthropic", AdapterFamily::Anthropic),
            ("gemini", AdapterFamily::Gemini),
            ("google", AdapterFamily::Gemini),
            ("Google-Gemini", AdapterFamily::Gemini),
        ] {
            let selection = provider_selection(input(name)).expect("installed family");
            assert_eq!(selection.family, expected, "{name}");
            assert_eq!(selection.base_url, "not a valid provider URL");
            assert!(selection.enabled);
            assert!(!selection.local_network_grant);
        }
    }

    #[test]
    fn authentication_vocabulary_and_local_grant_are_preserved() {
        for (name, expected) in [
            ("none", AuthScheme::None),
            (" NONE ", AuthScheme::None),
            ("bearer", AuthScheme::Bearer),
            ("Bearer", AuthScheme::Bearer),
            ("api_key_header", AuthScheme::ApiKeyHeader),
            ("API-Key-Header", AuthScheme::ApiKeyHeader),
            ("api key header", AuthScheme::ApiKeyHeader),
        ] {
            let mut profile = input("local");
            profile.auth_scheme = name;
            profile.local_network_grant = true;
            let selection = provider_selection(profile).expect("supported authentication");
            assert_eq!(selection.auth, expected, "{name}");
            assert!(selection.local_network_grant);
        }
        let mut profile = input("openai");
        profile.auth_scheme = "oauth";
        let error = provider_selection(profile).err().expect("unsupported auth");
        assert_eq!(error.code, "unsupported_auth_scheme");
        assert_eq!(
            error.message,
            "The provider authentication scheme is not supported by the agent harness"
        );
        assert_eq!(error.source, "native");
        assert_eq!(error.acceptance, None);
        assert_eq!(error.error_class, None);
        assert!(!error.retryable);
    }

    #[test]
    fn routing_headers_only_follow_exact_normalized_openai_profile_types() {
        for name in [
            "openai",
            " OPENAI ",
            "OpenAI-Compatible",
            "openai compatible",
        ] {
            let selection = provider_selection(input(name)).expect("OpenAI routing");
            assert_eq!(selection.organization.as_deref(), Some("fixture-org"));
            assert_eq!(selection.project.as_deref(), Some("fixture-project"));
        }
        for name in [
            "deepseek",
            "local",
            "anthropic",
            "gemini",
            "google",
            "google_gemini",
        ] {
            let selection = provider_selection(input(name)).expect("other installed family");
            assert_eq!(selection.organization, None, "{name}");
            assert_eq!(selection.project, None, "{name}");
        }
        let mut profile = input("openai");
        profile.organization = None;
        profile.project = None;
        let selection = provider_selection(profile).expect("absent optional routing");
        assert_eq!(selection.organization, None);
        assert_eq!(selection.project, None);
    }

    #[test]
    fn disabled_precedes_family_and_auth_and_family_precedes_auth() {
        let mut profile = input("unsupported");
        profile.auth_scheme = "unsupported";
        profile.enabled = false;
        let error = provider_selection(profile).err().expect("disabled");
        assert_eq!(error.code, "provider_disabled");
        assert_eq!(error.message, "The selected provider is disabled");
        assert_eq!(error.source, "native");
        assert_eq!(error.acceptance, None);
        assert_eq!(error.error_class, None);
        assert!(!error.retryable);

        let mut profile = input("unsupported");
        profile.auth_scheme = "unsupported";
        let error = provider_selection(profile)
            .err()
            .expect("unsupported family");
        assert_eq!(error.code, "unsupported_provider");
        assert_eq!(error.source, "provider");
        assert_eq!(error.acceptance, Some("false"));
        assert_eq!(error.error_class, Some(ProviderErrorClass::Unknown));
    }

    #[test]
    fn unavailable_and_unknown_family_errors_keep_static_provider_metadata() {
        for (name, code, message) in [
            (
                "azure",
                "provider_not_available",
                "Azure OpenAI deployment and API-version routing are not available in this preview",
            ),
            (
                "Azure OpenAI",
                "provider_not_available",
                "Azure OpenAI deployment and API-version routing are not available in this preview",
            ),
            (
                "custom",
                "provider_not_available",
                "Declarative custom adapters are not available in this preview",
            ),
            (
                "Custom-Adapter",
                "provider_not_available",
                "Declarative custom adapters are not available in this preview",
            ),
            (
                "private-provider-text",
                "unsupported_provider",
                "This provider type has no installed native adapter",
            ),
        ] {
            let error = provider_selection(input(name)).err().expect("unavailable");
            assert_eq!(error.code, code);
            assert_eq!(error.message, message);
            assert_eq!(error.source, "provider");
            assert_eq!(error.acceptance, Some("false"));
            assert_eq!(error.error_class, Some(ProviderErrorClass::Unknown));
            assert_eq!(error.status, None);
            assert_eq!(error.retry_after_ms, None);
            assert!(!error.retryable);
            assert!(!error.diagnostic_id.is_empty());
        }
    }

    #[test]
    fn destination_translation_preserves_retryability_and_class_without_new_metadata() {
        for (class, expected) in [
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
                    code: "fixture_destination_failure",
                    message: "Static destination diagnostic",
                    retryable,
                    class,
                });
                assert_eq!(error.code, "fixture_destination_failure");
                assert_eq!(error.message, "Static destination diagnostic");
                assert_eq!(error.retryable, retryable);
                assert_eq!(error.error_class, expected);
                assert_eq!(
                    error.source,
                    if expected.is_some() {
                        "provider"
                    } else {
                        "native"
                    }
                );
                assert_eq!(error.acceptance, None);
                assert_eq!(error.status, None);
                assert_eq!(error.retry_after_ms, None);
            }
        }
    }

    #[tokio::test]
    async fn missing_credential_rejects_before_invalid_destination() {
        for credential in [None, Some(String::new()), Some(" \t".to_owned())] {
            let mut profile = input("openai");
            profile.auth_scheme = "bearer";
            let error = build_provider(profile, credential, None)
                .await
                .err()
                .expect("missing credential");
            assert_eq!(error.code, "secret_missing");
            assert_eq!(error.message, "The provider credential is missing");
            assert_eq!(error.source, "native");
            assert_eq!(error.error_class, None);
            assert!(!error.retryable);
        }
    }

    #[tokio::test]
    async fn credential_and_routing_header_failures_reject_before_destination() {
        let mut profile = input("openai");
        profile.auth_scheme = "bearer";
        let error = build_provider(profile, Some("fixture\r\ninjected".to_owned()), None)
            .await
            .err()
            .expect("invalid credential header");
        assert_eq!(error.code, "invalid_provider_header");
        assert_eq!(
            error.message,
            "The provider authentication or routing header is invalid"
        );
        assert_eq!(error.source, "native");
        assert_eq!(error.error_class, None);
        assert!(!error.retryable);

        for invalid_organization in [true, false] {
            let mut profile = input("openai_compatible");
            if invalid_organization {
                profile.organization = Some("fixture\r\ninjected");
            } else {
                profile.project = Some("fixture\r\ninjected");
            }
            let error = build_provider(profile, None, None)
                .await
                .err()
                .expect("invalid routing header");
            assert_eq!(error.code, "invalid_provider_header");
            assert_eq!(error.source, "native");
            assert_eq!(error.acceptance, None);
        }
    }
}
