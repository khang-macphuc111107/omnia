use std::path::{Path, PathBuf};

use omnia_core::{is_valid_utf8, utf8_has_control_chars};
use thiserror::Error;

/// Canonical usage banner displayed when invalid CLI flags are passed to `omnia-native`.
pub const USAGE_TEXT: &str = "Usage: omnia-native [--session-db <absolute isolated database path>]";

/// Structured CLI parsing error for `omnia-native` and `omnia_qa_seed`.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{code}: {message}")]
pub struct CliError {
    pub code: &'static str,
    pub message: String,
}

impl CliError {
    /// Construct a new [`CliError`].
    #[must_use]
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Validate a `--session-db` path candidate (must be non-empty, UTF-8 control-free, and absolute).
pub fn validate_session_db_path(raw: &str) -> Result<PathBuf, CliError> {
    if !is_valid_utf8(raw.as_bytes()) || utf8_has_control_chars(raw) {
        return Err(CliError::new(
            "invalid_cli_args",
            "--session-db path contains invalid characters",
        ));
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CliError::new(
            "invalid_cli_args",
            "--session-db requires a non-empty path",
        ));
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err(CliError::new(
            "invalid_cli_args",
            "--session-db path must be absolute",
        ));
    }
    if path.file_name().is_none() {
        return Err(CliError::new(
            "invalid_cli_args",
            "--session-db path must include a database filename",
        ));
    }
    Ok(path.to_path_buf())
}

/// Parse `omnia-native` command-line arguments excluding `argv[0]`.
///
/// Accepts either zero arguments (storage remains disconnected for privacy) or
/// `--session-db <absolute isolated database path>`.
pub fn parse_session_db_args(args: &[String]) -> Result<Option<PathBuf>, CliError> {
    let mut database: Option<PathBuf> = None;
    let mut index = 0usize;
    while index < args.len() {
        let arg = &args[index];
        if arg != "--session-db" || database.is_some() {
            return Err(CliError::new("invalid_cli_args", USAGE_TEXT));
        }
        if index + 1 >= args.len() {
            return Err(CliError::new(
                "invalid_cli_args",
                "--session-db requires a path",
            ));
        }
        let next = &args[index + 1];
        database = Some(validate_session_db_path(next)?);
        index += 2;
    }
    Ok(database)
}

/// Parse `omnia_qa_seed` command-line arguments excluding `argv[0]`.
///
/// Expects exactly one non-existent absolute fixture directory path.
pub fn parse_qa_seed_directory_arg(args: &[String]) -> Result<PathBuf, CliError> {
    if args.len() != 1 {
        return Err(CliError::new(
            "invalid_cli_args",
            "supply a new absolute fixture directory",
        ));
    }
    let raw = args[0].as_str();
    if !is_valid_utf8(raw.as_bytes()) || utf8_has_control_chars(raw) || raw.trim().is_empty() {
        return Err(CliError::new(
            "invalid_cli_args",
            "supply a new absolute fixture directory",
        ));
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(CliError::new(
            "invalid_cli_args",
            "fixture directory must be absolute",
        ));
    }
    Ok(path)
}
