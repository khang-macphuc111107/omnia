use thiserror::Error;

#[derive(Debug, Error)]
pub enum HarnessError {
    #[error("provider error ({status:?}): {message}")]
    Provider {
        status: Option<u16>,
        message: String,
        retryable: bool,
    },
    #[error("stream protocol error: {0}")]
    Protocol(String),
    #[error("tool `{tool}` failed: {message}")]
    Tool { tool: String, message: String },
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("Token budget reached ({used}/{budget}). Raise it in session settings to continue.")]
    BudgetExceeded { used: u64, budget: u64 },
    #[error("cancelled")]
    Cancelled,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

impl HarnessError {
    pub fn tool(tool: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Tool {
            tool: tool.into(),
            message: message.into(),
        }
    }
}

pub type HarnessResult<T> = Result<T, HarnessError>;
