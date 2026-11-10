//! Tool abstraction shared by built-in tools, MCP tools and subagents.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;

use crate::{Block, HarnessResult, ToolSpec};

/// What a tool can do to the world. Permission rules and scheduling key off
/// this: read-only effects may run in parallel, the rest run one at a time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectClass {
    PureCompute,
    ReadWorkspace,
    WriteWorkspace,
    ExecuteProcess,
    Network,
    BrowserControl,
    ComputerControl,
}

impl EffectClass {
    pub fn is_read_only(self) -> bool {
        matches!(self, Self::PureCompute | Self::ReadWorkspace)
    }
}

/// Per-file arbitration shared by a root context and all of its descendants.
/// Only live/queued mutations retain a path lock; reads do not use this map.
#[derive(Default)]
pub struct FileMutationLocks {
    paths: Mutex<BTreeMap<PathBuf, Weak<AsyncMutex<()>>>>,
}

impl FileMutationLocks {
    fn for_path(&self, key: PathBuf) -> Arc<AsyncMutex<()>> {
        let mut paths = self.paths.lock().unwrap_or_else(|error| error.into_inner());
        paths.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = paths.get(&key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(AsyncMutex::new(()));
        paths.insert(key, Arc::downgrade(&lock));
        lock
    }
}

/// Resolve existing ancestors as well as existing files, so an absent file has
/// the same key before/after creation and symlinked parent aliases converge.
/// This key only coordinates tools; it does not grant filesystem authority.
async fn file_mutation_key(path: &Path) -> Result<PathBuf, String> {
    let mut ancestor = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("cannot resolve {}: {error}", path.display()))?
            .join(path)
    };
    let mut suffix = Vec::new();
    let canonical = loop {
        match tokio::fs::canonicalize(&ancestor).await {
            Ok(canonical) => break canonical,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let component = ancestor.components().next_back().ok_or_else(|| {
                    format!("cannot resolve mutation path {}: {error}", path.display())
                })?;
                match component {
                    Component::Normal(_) | Component::CurDir | Component::ParentDir => {
                        suffix.push(component.as_os_str().to_owned());
                    }
                    _ => {
                        return Err(format!(
                            "cannot resolve mutation path {}: {error}",
                            path.display()
                        ));
                    }
                }
                if !ancestor.pop() {
                    return Err(format!(
                        "cannot resolve mutation path {}: {error}",
                        path.display()
                    ));
                }
            }
            Err(error) => {
                return Err(format!(
                    "cannot resolve mutation path {}: {error}",
                    path.display()
                ));
            }
        }
    };
    let mut joined = canonical;
    for component in suffix.into_iter().rev() {
        joined.push(component);
    }
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    // Windows aliases commonly differ only in case. Case-sensitive Windows
    // directories may be over-serialized, which is preferable to a lost edit.
    #[cfg(windows)]
    let normalized = PathBuf::from(normalized.to_string_lossy().to_lowercase());
    Ok(normalized)
}

#[derive(Clone)]
pub struct ToolContext {
    /// Working directory for relative paths and processes.
    pub cwd: PathBuf,
    pub session_id: String,
    /// Id of the tool call being executed (empty outside a call).
    pub tool_use_id: String,
    pub cancel: CancellationToken,
    /// Shared request-boundary token budget for the root and child agents.
    /// Child contexts clone this handle; ordinary tool contexts leave it None.
    pub token_budget: Option<crate::SharedTokenBudget>,
    /// Leaf file mutations share this arbiter across cloned child contexts.
    /// Do not acquire it around TaskTool, which may itself await child writes.
    pub file_mutations: Arc<FileMutationLocks>,
    /// Sink for streaming partial output (e.g. a long shell command).
    pub progress: Option<Arc<dyn Fn(String) + Send + Sync>>,
    /// Per-turn file checkpoint; write tools record prior file state here.
    pub checkpoint: Option<crate::CheckpointScope>,
}

impl ToolContext {
    /// Wait for this file's mutation slot without blocking unrelated paths.
    /// The caller must keep the owned guard through the actual I/O completion,
    /// including if its async wrapper is dropped during a blocking write.
    pub async fn lock_file_mutation(&self, path: &Path) -> Result<OwnedMutexGuard<()>, String> {
        let key = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err("cancelled".into()),
            key = file_mutation_key(path) => key?,
        };
        let lock = self.file_mutations.for_path(key);
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err("cancelled".into()),
            guard = lock.lock_owned() => {
                if self.cancel.is_cancelled() {
                    Err("cancelled".into())
                } else {
                    Ok(guard)
                }
            }
        }
    }

    /// Records `path`'s current state before a write tool changes it. No-op
    /// without a checkpoint scope. An error means the file must not be changed.
    pub fn checkpoint_before(&self, path: &std::path::Path) -> Result<(), String> {
        match &self.checkpoint {
            Some(scope) => scope.store.record_before(scope.key(), path),
            None => Ok(()),
        }
    }

    /// Notes that a command whose file effects cannot be tracked is running.
    pub fn checkpoint_note_untracked(&self) -> Result<(), String> {
        if let Some(scope) = &self.checkpoint {
            scope.store.note_untracked_command(scope.key())?;
        }
        Ok(())
    }

    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            session_id: String::new(),
            tool_use_id: String::new(),
            cancel: CancellationToken::new(),
            token_budget: None,
            file_mutations: Arc::new(FileMutationLocks::default()),
            progress: None,
            checkpoint: None,
        }
    }

    pub fn resolve(&self, path: &str) -> PathBuf {
        let candidate = PathBuf::from(path);
        if candidate.is_absolute() {
            candidate
        } else {
            self.cwd.join(candidate)
        }
    }

    pub fn report(&self, chunk: impl Into<String>) {
        if let Some(progress) = &self.progress {
            progress(chunk.into());
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolOutput {
    pub content: Vec<Block>,
    pub is_error: bool,
}

impl ToolOutput {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![Block::text(text)],
            is_error: false,
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            content: vec![Block::text(text)],
            is_error: true,
        }
    }
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;
    fn effect(&self) -> EffectClass;
    /// Short human summary of a call for approval cards, e.g. "Run `git status`".
    fn describe(&self, input: &Value) -> String {
        format!("{} {}", self.spec().name, input)
    }
    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput>;
    fn as_any(&self) -> Option<&dyn std::any::Any> {
        None
    }
}

#[derive(Default, Clone)]
pub struct ToolRegistry {
    tools: BTreeMap<String, Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub fn register(&mut self, tool: Arc<dyn Tool>) {
        self.tools.insert(tool.spec().name, tool);
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    pub fn specs(&self) -> Vec<ToolSpec> {
        self.tools.values().map(|tool| tool.spec()).collect()
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.tools.keys().map(String::as_str)
    }
}
