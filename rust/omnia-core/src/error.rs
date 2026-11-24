/// Errors returned by `omnia-core` hashing, encoding, UTF-8, JSON, and RNG helpers.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CoreError {
    #[error("invalid hex input: {0}")]
    InvalidHex(String),

    #[error("invalid base64 input: {0}")]
    InvalidBase64(String),

    #[error("invalid UTF-8 input: {0}")]
    InvalidUtf8(String),

    #[error("invalid UTF-16 input: {0}")]
    InvalidUtf16(String),

    #[error("invalid JSON input: {0}")]
    InvalidJson(String),

    #[error("OS CSPRNG failed: {0}")]
    RngFailed(String),

    #[error("credential store error: {0}")]
    CredentialError(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),
}
