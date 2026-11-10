//! Transport-independent construction of the installed provider adapters.
//!
//! The host owns profile selection, frozen-definition verification and secret
//! acquisition. This module validates authentication and destination policy
//! before constructing an adapter. It does not start a run or create a runtime.

use std::{fmt, sync::Arc};

use reqwest::header::{HeaderName, HeaderValue};

use super::{
    anthropic::AnthropicProvider,
    destination::{self, DestinationError, DestinationErrorClass},
    gemini::GeminiProvider,
    openai_chat::OpenAiChatProvider,
    openai_responses::OpenAiResponsesProvider,
    record::RequestLog,
    sse::auth_headers,
    Provider, ProviderConfig,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdapterFamily {
    OpenAiChat,
    OpenAiResponses,
    Anthropic,
    Gemini,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthScheme {
    None,
    Bearer,
    ApiKeyHeader,
}

/// Immutable host-selected endpoint metadata. Deliberately not `Debug`: URLs
/// and optional organization/project identifiers are not diagnostic payloads.
pub struct ProviderSelection {
    pub base_url: String,
    pub enabled: bool,
    pub local_network_grant: bool,
    pub family: AdapterFamily,
    pub auth: AuthScheme,
    /// The host applies provider-profile routing before supplying these fields.
    pub organization: Option<String>,
    pub project: Option<String>,
}

/// All diagnostics are static and never retain a credential or header value.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FactoryError {
    Destination(DestinationError),
    MissingCredential,
    InvalidHeader,
}

impl fmt::Display for FactoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Destination(error) => error.fmt(formatter),
            Self::MissingCredential => formatter.write_str("The provider credential is missing"),
            Self::InvalidHeader => {
                formatter.write_str("The provider authentication or routing header is invalid")
            }
        }
    }
}

impl std::error::Error for FactoryError {}

impl From<DestinationError> for FactoryError {
    fn from(error: DestinationError) -> Self {
        Self::Destination(error)
    }
}

fn prepare_config(
    selection: &ProviderSelection,
    credential: Option<String>,
) -> Result<ProviderConfig, FactoryError> {
    let secret = match selection.auth {
        // An unrelated or stale credential must never accidentally be sent.
        AuthScheme::None => None,
        _ => Some(
            credential
                .filter(|value| !value.trim().is_empty())
                .ok_or(FactoryError::MissingCredential)?,
        ),
    };
    let mut config = ProviderConfig {
        base_url: selection.base_url.clone(),
        api_key: None,
        bearer_auth: selection.auth == AuthScheme::Bearer,
        extra_headers: Vec::new(),
    };
    match (selection.family, selection.auth) {
        (_, AuthScheme::None) => {}
        (AdapterFamily::OpenAiChat | AdapterFamily::OpenAiResponses, AuthScheme::ApiKeyHeader) => {
            if let Some(secret) = secret {
                config.extra_headers.push(("api-key".to_owned(), secret));
            }
        }
        (_, AuthScheme::ApiKeyHeader | AuthScheme::Bearer) => config.api_key = secret,
    }
    if let Some(organization) = &selection.organization {
        config
            .extra_headers
            .push(("OpenAI-Organization".to_owned(), organization.clone()));
    }
    if let Some(project) = &selection.project {
        config
            .extra_headers
            .push(("OpenAI-Project".to_owned(), project.clone()));
    }

    // Validate the exact effective headers, including the Bearer prefix used
    // by both OpenAI adapters. Errors from reqwest must not echo input values.
    let mut effective = config.clone();
    let (key_header, fixed): (&str, &[(&str, &str)]) = match selection.family {
        AdapterFamily::OpenAiChat | AdapterFamily::OpenAiResponses => {
            effective.bearer_auth = true;
            ("authorization", &[])
        }
        AdapterFamily::Anthropic => ("x-api-key", &[("anthropic-version", "2023-06-01")]),
        AdapterFamily::Gemini => ("x-goog-api-key", &[]),
    };
    for (name, value) in auth_headers(&effective, key_header, fixed) {
        HeaderName::from_bytes(name.as_bytes()).map_err(|_| FactoryError::InvalidHeader)?;
        HeaderValue::from_str(&value).map_err(|_| FactoryError::InvalidHeader)?;
    }
    Ok(config)
}

/// Build an adapter with the shared validated, pinned HTTP client.
///
/// No network request is dispatched by construction. A DNS lookup may occur;
/// its deadline and internal allocations remain the destination module's
/// separate contract. The host must retain the chosen endpoint/profile
/// authority and must not treat construction as a completed provider run.
pub async fn build_provider(
    selection: ProviderSelection,
    credential: Option<String>,
    request_log: Option<Arc<RequestLog>>,
) -> Result<Arc<dyn Provider>, FactoryError> {
    if !selection.enabled {
        return Err(FactoryError::Destination(DestinationError {
            code: "provider_disabled",
            message: "The selected provider is disabled",
            retryable: false,
            class: DestinationErrorClass::Policy,
        }));
    }
    let config = prepare_config(&selection, credential)?;
    let client = destination::validated_client(
        &selection.base_url,
        selection.enabled,
        selection.local_network_grant,
    )
    .await?;
    macro_rules! build {
        ($adapter:ty) => {{
            let adapter = <$adapter>::with_client(config, client);
            match request_log {
                Some(log) => Arc::new(adapter.with_recorder(log)) as Arc<dyn Provider>,
                None => Arc::new(adapter) as Arc<dyn Provider>,
            }
        }};
    }
    Ok(match selection.family {
        AdapterFamily::OpenAiChat => build!(OpenAiChatProvider),
        AdapterFamily::OpenAiResponses => build!(OpenAiResponsesProvider),
        AdapterFamily::Anthropic => build!(AnthropicProvider),
        AdapterFamily::Gemini => build!(GeminiProvider),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HarnessError, ProviderRequest, StreamEvent};
    use futures_util::StreamExt;
    use std::time::Duration;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    const KEY: &str = "synthetic-factory-fixture-key";

    fn selection(family: AdapterFamily, auth: AuthScheme) -> ProviderSelection {
        ProviderSelection {
            base_url: "http://127.0.0.1:11434".to_owned(),
            enabled: true,
            local_network_grant: true,
            family,
            auth,
            organization: None,
            project: None,
        }
    }

    #[test]
    fn all_family_auth_combinations_keep_header_contracts() {
        for family in [
            AdapterFamily::OpenAiChat,
            AdapterFamily::OpenAiResponses,
            AdapterFamily::Anthropic,
            AdapterFamily::Gemini,
        ] {
            for auth in [
                AuthScheme::None,
                AuthScheme::Bearer,
                AuthScheme::ApiKeyHeader,
            ] {
                let config = prepare_config(&selection(family, auth), Some(KEY.into())).unwrap();
                match (family, auth) {
                    (_, AuthScheme::None) => {
                        assert!(config.api_key.is_none());
                        assert!(config.extra_headers.is_empty());
                    }
                    (
                        AdapterFamily::OpenAiChat | AdapterFamily::OpenAiResponses,
                        AuthScheme::ApiKeyHeader,
                    ) => {
                        assert!(config.api_key.is_none());
                        assert_eq!(config.extra_headers, vec![("api-key".into(), KEY.into())]);
                    }
                    (_, AuthScheme::Bearer | AuthScheme::ApiKeyHeader) => {
                        assert_eq!(config.api_key.as_deref(), Some(KEY));
                        assert_eq!(config.bearer_auth, auth == AuthScheme::Bearer);
                        assert!(config.extra_headers.is_empty());
                    }
                }
                let mut effective = config;
                let key_header = match family {
                    AdapterFamily::OpenAiChat | AdapterFamily::OpenAiResponses => {
                        effective.bearer_auth = true;
                        "authorization"
                    }
                    AdapterFamily::Anthropic => "x-api-key",
                    AdapterFamily::Gemini => "x-goog-api-key",
                };
                let headers = auth_headers(&effective, key_header, &[]);
                let expected = match (family, auth) {
                    (_, AuthScheme::None) => Vec::new(),
                    (
                        AdapterFamily::OpenAiChat | AdapterFamily::OpenAiResponses,
                        AuthScheme::ApiKeyHeader,
                    ) => vec![("api-key".to_owned(), KEY.to_owned())],
                    (_, AuthScheme::Bearer) => {
                        vec![("authorization".to_owned(), format!("Bearer {KEY}"))]
                    }
                    (_, AuthScheme::ApiKeyHeader) => {
                        vec![(key_header.to_owned(), KEY.to_owned())]
                    }
                };
                assert_eq!(headers, expected, "{family:?}/{auth:?}");
            }
        }
    }

    #[tokio::test]
    async fn builds_every_family_and_auth_without_dispatch() {
        for (family, id) in [
            (AdapterFamily::OpenAiChat, "openai_chat"),
            (AdapterFamily::OpenAiResponses, "openai_responses"),
            (AdapterFamily::Anthropic, "anthropic"),
            (AdapterFamily::Gemini, "gemini"),
        ] {
            for auth in [
                AuthScheme::None,
                AuthScheme::Bearer,
                AuthScheme::ApiKeyHeader,
            ] {
                let provider = build_provider(
                    selection(family, auth),
                    Some(KEY.into()),
                    Some(RequestLog::new()),
                )
                .await
                .unwrap();
                assert_eq!(provider.id(), id);
            }
        }
    }

    #[test]
    fn routing_fields_are_explicit_and_validated() {
        let mut selected = selection(AdapterFamily::OpenAiChat, AuthScheme::None);
        selected.organization = Some("org-fixture".into());
        selected.project = Some("project-fixture".into());
        let config = prepare_config(&selected, None).unwrap();
        assert_eq!(
            config.extra_headers,
            vec![
                ("OpenAI-Organization".into(), "org-fixture".into()),
                ("OpenAI-Project".into(), "project-fixture".into())
            ]
        );
        selected.project = Some("project\r\nInjected: value".into());
        assert!(matches!(
            prepare_config(&selected, None),
            Err(FactoryError::InvalidHeader)
        ));
    }

    #[tokio::test]
    async fn missing_credential_and_invalid_headers_fail_before_dns() {
        for auth in [AuthScheme::Bearer, AuthScheme::ApiKeyHeader] {
            let mut selected = selection(AdapterFamily::Anthropic, auth);
            selected.base_url = "https://unresolvable-factory-fixture.invalid".into();
            let error = build_provider(selected, None, None).await.err().unwrap();
            assert_eq!(error, FactoryError::MissingCredential);
        }
        let mut selected = selection(AdapterFamily::OpenAiChat, AuthScheme::Bearer);
        selected.base_url = "not a URL".into();
        let error = build_provider(selected, Some("private\r\nInjected: hidden".into()), None)
            .await
            .err()
            .unwrap();
        assert_eq!(error, FactoryError::InvalidHeader);
        assert!(!format!("{error} {error:?}").contains("private"));
        assert!(!format!("{error} {error:?}").contains("Injected"));
    }

    #[test]
    fn empty_credential_is_missing_but_none_auth_discards_supplied_secret() {
        for key in [None, Some(String::new()), Some("  ".into())] {
            assert!(matches!(
                prepare_config(
                    &selection(AdapterFamily::Gemini, AuthScheme::ApiKeyHeader),
                    key
                ),
                Err(FactoryError::MissingCredential)
            ));
        }
        let config = prepare_config(
            &selection(AdapterFamily::Anthropic, AuthScheme::None),
            Some("ignored\r\ncredential".into()),
        )
        .unwrap();
        assert!(config.api_key.is_none());
        assert!(config.extra_headers.is_empty());
    }

    #[tokio::test]
    async fn disabled_precedes_credential_url_and_dns_validation() {
        let mut selected = selection(AdapterFamily::Gemini, AuthScheme::Bearer);
        selected.enabled = false;
        selected.base_url = "not a URL".into();
        let error = build_provider(selected, None, None).await.err().unwrap();
        assert!(matches!(
            error,
            FactoryError::Destination(DestinationError {
                code: "provider_disabled",
                retryable: false,
                ..
            })
        ));
    }

    async fn response_server(response: Vec<u8>) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(5), async move {
                let (mut connection, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut bytes = [0; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let read = connection.read(&mut bytes).await.unwrap();
                    assert_ne!(read, 0);
                    request.extend_from_slice(&bytes[..read]);
                    assert!(request.len() <= 32 * 1024);
                }
                connection.write_all(&response).await.unwrap();
                String::from_utf8(request).unwrap()
            })
            .await
            .unwrap()
        });
        (format!("http://{address}"), task)
    }

    #[tokio::test]
    async fn constructed_provider_dispatches_and_normalizes_loopback_sse() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"native factory\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let (base_url, task) = response_server(response.into_bytes()).await;
        let mut selected = selection(AdapterFamily::OpenAiChat, AuthScheme::ApiKeyHeader);
        selected.base_url = base_url;
        let provider = build_provider(selected, Some(KEY.into()), None)
            .await
            .unwrap();
        let mut stream = provider
            .stream(ProviderRequest {
                model: "fixture-model".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        let events = tokio::time::timeout(Duration::from_secs(5), async move {
            let mut events = Vec::new();
            while let Some(event) = stream.next().await {
                events.push(event.unwrap());
            }
            events
        })
        .await
        .unwrap();
        assert!(events.iter().any(
            |event| matches!(event, StreamEvent::TextDelta { text } if text == "native factory")
        ));
        let request = task.await.unwrap().to_ascii_lowercase();
        assert!(request.starts_with("post /v1/chat/completions "));
        assert!(request.contains(&format!("api-key: {KEY}")));
        assert!(!request.contains("authorization:"));
    }

    #[tokio::test]
    async fn constructed_provider_rejects_redirect_without_reaching_target() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let response = format!(
            "HTTP/1.1 302 Found\r\nLocation: http://{}/forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            target.local_addr().unwrap()
        );
        let (base_url, task) = response_server(response.into_bytes()).await;
        let mut selected = selection(AdapterFamily::OpenAiChat, AuthScheme::None);
        selected.base_url = base_url;
        let provider = build_provider(selected, None, None).await.unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            provider.stream(ProviderRequest {
                model: "fixture-model".into(),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
        assert!(matches!(
            result,
            Err(HarnessError::Provider {
                status: Some(302),
                ..
            })
        ));
        task.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), target.accept())
                .await
                .is_err()
        );
    }
}
