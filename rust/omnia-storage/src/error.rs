use omnia_core::CoreError;
use omnia_winsqlite::WinSqliteError;

/// Canonical structured error returned across `omnia-storage` stores, navigation,
/// provider/secret resolution, run coordination, and async session workers.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct StoreError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl StoreError {
    #[must_use]
    pub fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
        }
    }

    #[must_use]
    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new("invalid_input", message, false)
    }

    #[must_use]
    pub fn storage_failed(message: impl Into<String>) -> Self {
        Self::new("harness_storage_failed", message, false)
    }

    #[must_use]
    pub fn not_found(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, message, false)
    }

    #[must_use]
    pub fn conflict(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, message, false)
    }
}

impl From<WinSqliteError> for StoreError {
    fn from(err: WinSqliteError) -> Self {
        let mapped_code = match err.code.as_str() {
            "harness_store_busy" | "harness_store_ownership_failed" | "invalid_input" => {
                err.code.clone()
            }
            _ => "harness_storage_failed".to_owned(),
        };
        Self {
            code: mapped_code,
            message: err.message,
            retryable: err.retryable,
        }
    }
}

impl From<CoreError> for StoreError {
    fn from(err: CoreError) -> Self {
        let code = match err {
            CoreError::InvalidJson(_) => "json_parse_error",
            _ => "invalid_input",
        };
        Self::new(code, err.to_string(), false)
    }
}
