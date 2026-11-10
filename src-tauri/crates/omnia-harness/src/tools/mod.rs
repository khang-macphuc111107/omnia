//! Built-in tools (H2): file, search, shell, web and task-list tools.
//!
//! Every tool is a small struct implementing [`Tool`]. Model-correctable
//! problems (bad arguments, missing files, non-unique edits) are returned as
//! `ToolOutput::error` so the model can retry; `Err(..)` is reserved for
//! cancellation and infrastructure failures.

pub mod artifact;
mod fs;
mod git;
mod http;
mod office;
mod patch;
mod search;
pub mod session_ipc;
mod shell;
mod shell_session;
mod sqlite;
mod todo;
mod web;

use std::path::Path;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::{HarnessError, HarnessResult, ToolContext, ToolOutput, ToolRegistry};

pub use fs::{EditFileTool, ListDirTool, MultiEditTool, ReadFileTool, WriteFileTool};
pub use git::{
    GhPrTool, GitBranchTool, GitCommitTool, GitConflictsTool, GitDiffTool, GitLogTool,
    GitMergeTool, GitPullTool, GitPushTool, GitRebaseTool, GitResolveTool, GitShowTool,
    GitStatusTool, GitWorktreeTool,
};
pub use http::HttpRequestTool;
pub use patch::ApplyPatchTool;
pub use search::{GlobTool, GrepTool};
pub use session_ipc::{SessionListTool, SessionReadTool, SessionSendTool};
pub use shell::{ShellKillTool, ShellOutputTool, ShellResetTool, ShellTool};
pub use sqlite::{SqliteExecuteTool, SqliteQueryTool};
pub use todo::{todos_for, TodoItem, TodoStatus, TodoWriteTool};
pub use web::{
    BraveBackend, DuckDuckGoBackend, FallbackBackend, SearchBackend, SearchConfig, SearchResult,
    SearxngBackend, WebFetchTool, WebSearchTool,
};

/// Registry with every built-in tool.
pub fn builtin_registry() -> ToolRegistry {
    let mut registry = read_only_registry();
    registry.register(Arc::new(WriteFileTool));
    registry.register(Arc::new(EditFileTool));
    registry.register(Arc::new(MultiEditTool));
    registry.register(Arc::new(ApplyPatchTool));
    registry.register(Arc::new(GitCommitTool));
    registry.register(Arc::new(GitBranchTool));
    registry.register(Arc::new(GitWorktreeTool));
    registry.register(Arc::new(GitMergeTool));
    registry.register(Arc::new(GitRebaseTool));
    registry.register(Arc::new(GitResolveTool));
    registry.register(Arc::new(GitPullTool));
    registry.register(Arc::new(GitPushTool));
    registry.register(Arc::new(GhPrTool));
    registry.register(Arc::new(ShellTool));
    registry.register(Arc::new(ShellOutputTool));
    registry.register(Arc::new(ShellKillTool));
    registry.register(Arc::new(ShellResetTool));
    registry.register(Arc::new(SqliteExecuteTool));
    registry.register(Arc::new(HttpRequestTool));
    registry.register(Arc::new(WebFetchTool));
    registry.register(Arc::new(WebSearchTool::default()));
    registry.register(Arc::new(artifact::ArtifactTool));
    registry.register(Arc::new(SessionSendTool));
    registry
}

/// Only tools whose effect is read-only (plus the in-memory todo list).
pub fn read_only_registry() -> ToolRegistry {
    let mut registry = ToolRegistry::default();
    registry.register(Arc::new(ReadFileTool));
    registry.register(Arc::new(GlobTool));
    registry.register(Arc::new(GrepTool));
    registry.register(Arc::new(ListDirTool));
    registry.register(Arc::new(GitStatusTool));
    registry.register(Arc::new(GitDiffTool));
    registry.register(Arc::new(GitLogTool));
    registry.register(Arc::new(GitShowTool));
    registry.register(Arc::new(GitConflictsTool));
    registry.register(Arc::new(SqliteQueryTool));
    registry.register(Arc::new(TodoWriteTool));
    registry.register(Arc::new(SessionListTool));
    registry.register(Arc::new(SessionReadTool));
    registry
}

pub(crate) fn parse_input<T: DeserializeOwned>(input: Value) -> Result<T, String> {
    serde_json::from_value(input).map_err(|error| format!("invalid arguments: {error}"))
}

/// Maps a model-correctable failure to an error result.
pub(crate) fn finish(result: Result<ToolOutput, String>) -> HarnessResult<ToolOutput> {
    Ok(result.unwrap_or_else(ToolOutput::error))
}

pub(crate) fn cancelled() -> HarnessError {
    HarnessError::Cancelled
}

/// Path relative to the session cwd when possible, always with `/`.
pub(crate) fn display_path(ctx: &ToolContext, path: &Path) -> String {
    let shown = path.strip_prefix(&ctx.cwd).unwrap_or(path);
    shown.to_string_lossy().replace('\\', "/")
}

pub(crate) fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push_str("...");
    out
}

pub(crate) fn short(text: &str) -> String {
    let first = text.lines().next().unwrap_or("");
    truncate_chars(first, 100)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registries() {
        let all = builtin_registry();
        let names: Vec<&str> = all.names().collect();
        for name in [
            "read_file",
            "write_file",
            "edit_file",
            "multi_edit",
            "apply_patch",
            "glob",
            "grep",
            "list_dir",
            "shell",
            "shell_output",
            "shell_kill",
            "shell_reset",
            "web_fetch",
            "web_search",
            "http_request",
            "sqlite_query",
            "sqlite_execute",
            "todo_write",
            "git_status",
            "git_diff",
            "git_log",
            "git_show",
            "git_commit",
            "git_branch",
            "git_worktree",
            "git_merge",
            "git_rebase",
            "git_pull",
            "git_push",
            "git_conflicts",
            "git_resolve",
            "gh_pr",
            "artifact",
        ] {
            assert!(names.contains(&name), "missing {name}");
        }
        for tool in read_only_registry().names() {
            assert!(all.get(tool).unwrap().effect().is_read_only(), "{tool}");
        }
        for spec in all.specs() {
            assert_eq!(spec.input_schema["type"], "object", "{}", spec.name);
        }
    }
}
