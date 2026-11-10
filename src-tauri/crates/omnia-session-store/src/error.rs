use serde::Serialize;
use uuid::Uuid;

pub type NativeResult<T> = Result<T, NativeError>;

/// Canonical provider failure taxonomy shared by native provider errors and
/// renderer-facing stream events.  Keep this allowlisted: provider response
/// text must never be allowed to create an arbitrary renderer classification.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)] // closed renderer-visible taxonomy; some classes are reserved for gateway paths not yet emitting them
pub enum ProviderErrorClass {
    Authentication,
    Authorization,
    Billing,
    RateLimit,
    Quota,
    Dns,
    Tls,
    Transport,
    Timeout,
    Protocol,
    Schema,
    ModelUnavailable,
    ContentPolicy,
    Cancelled,
    Unknown,
}

impl ProviderErrorClass {
    #[cfg(any(test, feature = "test-support"))]
    /// Return the only renderer/storage spelling accepted for this class.
    ///
    /// Provider responses are untrusted input, so every boundary that accepts
    /// a textual class must round-trip through this allowlist instead of
    /// persisting arbitrary strings.  Keep this list in lockstep with the
    /// serde kebab-case representation above and the TypeScript domain union.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Authentication => "authentication",
            Self::Authorization => "authorization",
            Self::Billing => "billing",
            Self::RateLimit => "rate-limit",
            Self::Quota => "quota",
            Self::Dns => "dns",
            Self::Tls => "tls",
            Self::Transport => "transport",
            Self::Timeout => "timeout",
            Self::Protocol => "protocol",
            Self::Schema => "schema",
            Self::ModelUnavailable => "model-unavailable",
            Self::ContentPolicy => "content-policy",
            Self::Cancelled => "cancelled",
            Self::Unknown => "unknown",
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    /// Parse a renderer/provider supplied class using the canonical
    /// kebab-case vocabulary.  Deliberately reject trimming, case folding,
    /// aliases, and arbitrary provider text so persisted telemetry cannot
    /// drift away from the typed taxonomy.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "authentication" => Some(Self::Authentication),
            "authorization" => Some(Self::Authorization),
            "billing" => Some(Self::Billing),
            "rate-limit" => Some(Self::RateLimit),
            "quota" => Some(Self::Quota),
            "dns" => Some(Self::Dns),
            "tls" => Some(Self::Tls),
            "transport" => Some(Self::Transport),
            "timeout" => Some(Self::Timeout),
            "protocol" => Some(Self::Protocol),
            "schema" => Some(Self::Schema),
            "model-unavailable" => Some(Self::ModelUnavailable),
            "content-policy" => Some(Self::ContentPolicy),
            "cancelled" => Some(Self::Cancelled),
            "unknown" => Some(Self::Unknown),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    /// Short-lived correlation handle for support/diagnostic lookup.  This is
    /// intentionally opaque and never contains request text, paths, headers,
    /// credentials, or provider response bodies.
    pub diagnostic_id: String,
    /// Coarse origin used by the renderer to choose safe recovery copy.  It is
    /// deliberately an allowlisted static value rather than an arbitrary
    /// provider/server string.
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acceptance: Option<&'static str>,
    /// Typed provider taxonomy.  This is optional because NativeError is also
    /// used for non-provider IPC failures; provider-originated failures set it
    /// before crossing the renderer boundary.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_class: Option<ProviderErrorClass>,
}

impl NativeError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            diagnostic_id: diagnostic_id(),
            source: "native",
            status: None,
            retry_after_ms: None,
            acceptance: None,
            error_class: None,
        }
    }

    pub fn retryable(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: true,
            diagnostic_id: diagnostic_id(),
            source: "native",
            status: None,
            retry_after_ms: None,
            acceptance: None,
            error_class: None,
        }
    }

    /// Adds normalized provider metadata without allowing provider-controlled
    /// text to cross the renderer boundary.  `acceptance` is restricted to the
    /// canonical values `false`, `true`, and `unknown` by the caller.
    pub fn with_provider_metadata(
        mut self,
        status: Option<u16>,
        retry_after_ms: Option<u64>,
        acceptance: Option<&'static str>,
    ) -> Self {
        self.source = "provider";
        self.status = status;
        self.retry_after_ms = retry_after_ms;
        self.acceptance = acceptance;
        self
    }

    /// Attach the canonical provider taxonomy without changing the safe
    /// human-readable message or any acceptance/retry metadata.
    pub fn with_provider_error_class(mut self, error_class: ProviderErrorClass) -> Self {
        self.source = "provider";
        self.error_class = Some(error_class);
        self
    }

    pub fn invalid(field: &'static str, reason: impl AsRef<str>) -> Self {
        Self::new("invalid_input", format!("{field} {}", reason.as_ref()))
    }

    pub fn database(_error: rusqlite::Error) -> Self {
        // SQLite diagnostics may contain SQL fragments, table names, bound
        // values, or filesystem paths. NativeError is serialized across the
        // renderer boundary, so retain only a coarse native diagnostic code
        // and return an allowlisted message to untrusted clients.
        #[cfg(debug_assertions)]
        eprintln!(
            "Omnia SQLite diagnostic code: {:?}",
            _error.sqlite_error_code()
        );
        Self::new(
            "storage_failed",
            "Local storage could not complete the operation",
        )
    }

    pub fn io(context: &'static str, _error: std::io::Error) -> Self {
        // std::io::Error frequently embeds an absolute path supplied by the
        // OS. Do not expose that path through Tauri IPC or debug output; the
        // static context is deliberately chosen by trusted native code.
        #[cfg(debug_assertions)]
        eprintln!(
            "Omnia filesystem diagnostic ({context}): {:?}",
            _error.kind()
        );
        Self::new("filesystem_failed", context)
    }
}

impl std::fmt::Display for NativeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for NativeError {}

impl From<rusqlite::Error> for NativeError {
    fn from(value: rusqlite::Error) -> Self {
        Self::database(value)
    }
}

fn diagnostic_id() -> String {
    format!("diag-{}", Uuid::new_v4())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_error_class_text_round_trips_through_the_canonical_allowlist() {
        let values = [
            ("authentication", ProviderErrorClass::Authentication),
            ("authorization", ProviderErrorClass::Authorization),
            ("billing", ProviderErrorClass::Billing),
            ("rate-limit", ProviderErrorClass::RateLimit),
            ("quota", ProviderErrorClass::Quota),
            ("dns", ProviderErrorClass::Dns),
            ("tls", ProviderErrorClass::Tls),
            ("transport", ProviderErrorClass::Transport),
            ("timeout", ProviderErrorClass::Timeout),
            ("protocol", ProviderErrorClass::Protocol),
            ("schema", ProviderErrorClass::Schema),
            ("model-unavailable", ProviderErrorClass::ModelUnavailable),
            ("content-policy", ProviderErrorClass::ContentPolicy),
            ("cancelled", ProviderErrorClass::Cancelled),
            ("unknown", ProviderErrorClass::Unknown),
        ];
        for (value, expected) in values {
            assert_eq!(ProviderErrorClass::parse(value), Some(expected));
            assert_eq!(expected.as_str(), value);
        }
        for invalid in [
            "",
            " Authentication",
            "AUTHENTICATION",
            "rate_limit",
            "provider-owned",
        ] {
            assert_eq!(ProviderErrorClass::parse(invalid), None);
        }
    }

    #[test]
    fn renderer_errors_do_not_expose_raw_filesystem_paths() {
        let error = NativeError::io(
            "The workspace file cannot be read",
            std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                r#"Access denied: C:\Users\alice\private\secret.txt"#,
            ),
        );
        assert_eq!(error.code, "filesystem_failed");
        assert_eq!(error.message, "The workspace file cannot be read");
        assert_eq!(error.source, "native");
        assert!(error.diagnostic_id.starts_with("diag-"));
        assert_eq!(error.diagnostic_id.len(), 41);
        assert!(!error.message.contains("alice"));
        assert!(!error.message.contains("secret.txt"));
    }

    #[test]
    fn renderer_errors_do_not_expose_sqlite_diagnostics() {
        let error = NativeError::database(rusqlite::Error::InvalidParameterName(
            "credential_ref=provider_secret_sensitive".to_owned(),
        ));
        assert_eq!(error.code, "storage_failed");
        assert_eq!(
            error.message,
            "Local storage could not complete the operation"
        );
        assert!(error.status.is_none());
        assert!(error.retry_after_ms.is_none());
        assert!(error.acceptance.is_none());
        assert!(!error.message.contains("credential_ref"));
        assert!(!error.message.contains("provider_secret_sensitive"));
    }

    #[test]
    fn provider_metadata_is_structured_and_does_not_change_safe_copy() {
        let error = NativeError::retryable(
            "provider_temporarily_unavailable",
            "The provider is temporarily unavailable",
        )
        .with_provider_metadata(Some(429), Some(3_000), Some("unknown"));

        assert_eq!(error.source, "provider");
        assert_eq!(error.status, Some(429));
        assert_eq!(error.retry_after_ms, Some(3_000));
        assert_eq!(error.acceptance, Some("unknown"));
        assert_eq!(error.error_class, None);
        assert_eq!(error.message, "The provider is temporarily unavailable");
        assert!(!error.message.contains("Retry-After"));
    }

    #[test]
    fn provider_metadata_serializes_as_bounded_renderer_fields() {
        let error = NativeError::retryable(
            "provider_temporarily_unavailable",
            "The provider is temporarily unavailable",
        )
        .with_provider_metadata(Some(429), Some(3_000), Some("unknown"))
        .with_provider_error_class(ProviderErrorClass::RateLimit);
        let value = serde_json::to_value(&error).expect("native errors must serialize");

        assert_eq!(value["code"], "provider_temporarily_unavailable");
        assert_eq!(value["retryable"], true);
        assert_eq!(value["source"], "provider");
        assert_eq!(value["status"], 429);
        assert_eq!(value["retryAfterMs"], 3_000);
        assert_eq!(value["acceptance"], "unknown");
        assert_eq!(value["errorClass"], "rate-limit");
        let diagnostic_id = value["diagnosticId"]
            .as_str()
            .expect("diagnostic ID must be serialized as text");
        assert!(diagnostic_id.starts_with("diag-"));
        assert_eq!(diagnostic_id.len(), 41);
    }
}
