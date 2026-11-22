use std::fmt;

/// Column storage classes returned by SQLite for an evaluated row column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnType {
    Null,
    Integer,
    Float,
    Text,
    Blob,
}

/// Result of stepping a prepared SQLite statement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepStatus {
    Row,
    Done,
}

/// Locking behavior when starting a SQLite transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxBehavior {
    Deferred,
    Immediate,
}

/// Structured error returned by WinSQLite FFI, file-ownership, and statement operations.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct WinSqliteError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub sqlite_code: Option<i32>,
    pub win32_code: Option<u32>,
}

impl WinSqliteError {
    #[must_use]
    pub fn sqlite(
        code: impl Into<String>,
        message: impl Into<String>,
        sqlite_code: i32,
        retryable: bool,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
            sqlite_code: Some(sqlite_code),
            win32_code: None,
        }
    }

    #[must_use]
    pub fn busy(
        code: impl Into<String>,
        message: impl Into<String>,
        win32_code: Option<u32>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: true,
            sqlite_code: None,
            win32_code,
        }
    }

    #[must_use]
    pub fn ownership_failed(message: impl Into<String>, win32_code: Option<u32>) -> Self {
        Self {
            code: "harness_store_ownership_failed".to_owned(),
            message: message.into(),
            retryable: false,
            sqlite_code: None,
            win32_code,
        }
    }

    #[must_use]
    pub fn storage_failed(message: impl Into<String>) -> Self {
        Self {
            code: "harness_storage_failed".to_owned(),
            message: message.into(),
            retryable: false,
            sqlite_code: None,
            win32_code: None,
        }
    }

    #[must_use]
    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_input".to_owned(),
            message: message.into(),
            retryable: false,
            sqlite_code: None,
            win32_code: None,
        }
    }

    #[must_use]
    pub fn format_win32_detail(prefix: &str, win32_code: u32) -> String {
        format!("{prefix} (win32={win32_code})")
    }
}

/// Diagnostic tag attached to formatted WinSQLite error logs.
impl fmt::Debug for ColumnTypeTag {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

#[allow(dead_code)]
struct ColumnTypeTag(&'static str);
