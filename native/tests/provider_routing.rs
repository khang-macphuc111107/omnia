//! Native consumer of the same provider routing policy as the desktop host.
//! Pure selection and pre-network failures; no real provider or credential.
use omnia_harness::provider::factory::{AdapterFamily, AuthScheme};
use omnia_provider_services::routing::{build_provider, provider_selection, ProviderProfileInput};

fn profile(provider_type: &str) -> ProviderProfileInput<'_> {
    ProviderProfileInput {
        provider_type,
        base_url: "not a URL",
        auth_scheme: "api-key-header",
        organization: Some("fixture-org"),
        project: Some("fixture-project"),
        enabled: true,
        local_network_grant: false,
    }
}

#[test]
fn native_selection_retains_adapter_and_routing_policy() {
    let selection = provider_selection(profile(" OpenAI Compatible ")).unwrap();
    assert_eq!(selection.family, AdapterFamily::OpenAiChat);
    assert_eq!(selection.auth, AuthScheme::ApiKeyHeader);
    assert_eq!(selection.organization.as_deref(), Some("fixture-org"));
    assert_eq!(selection.project.as_deref(), Some("fixture-project"));
    let selection = provider_selection(profile("deepseek")).unwrap();
    assert!(selection.organization.is_none());
    assert!(selection.project.is_none());
    let selection = provider_selection(profile("openai")).unwrap();
    assert_eq!(selection.family, AdapterFamily::OpenAiResponses);
}

#[tokio::test]
async fn native_disabled_and_missing_secret_fail_before_destination_work() {
    let mut disabled = profile("unsupported");
    disabled.enabled = false;
    let error = build_provider(disabled, None, None).await.err().unwrap();
    assert_eq!(error.code, "provider_disabled");
    let error = build_provider(profile("openai"), None, None)
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, "secret_missing");
    assert!(!error.retryable);
}
