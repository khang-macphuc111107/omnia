//! Language Server Protocol tools: definition, references, hover, symbols,
//! diagnostics and safe rename for any language with an LSP server.
//!
//! Servers are spawned lazily over stdio, kept alive per
//! `(workspace root, server)` and shut down after 10 idle minutes. See
//! [`register`] for how the bridge wires the tools in.

mod client;
mod config;
mod framing;
mod text;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

pub use client::{LspClient, LspError};
pub use config::{
    default_specs, load_specs, load_specs_from_snapshot, LoadedSpecs, ServerSpec, SpecSource,
};
pub use text::{apply_text_edits, parse_workspace_edit, TextEdit};

use client::{Doc, Launch};
use text::{char_col_to_utf16, path_key, relative_to, uri_to_path, utf16_to_char_col, LineIndex};

use crate::tools::parse_input;
use crate::{
    EffectClass, HarnessError, HarnessResult, Tool, ToolContext, ToolOutput, ToolRegistry, ToolSpec,
};

pub const IDLE_SHUTDOWN: Duration = Duration::from_secs(10 * 60);
const MAX_LOCATIONS: usize = 100;
const MAX_SYMBOLS: usize = 200;
const MAX_DIAGNOSTICS: usize = 100;

/// Registers the `lsp_*` tools. `omnia_home` locates the user `lsp.json`;
/// `trusted` gates `<cwd>/.omnia/lsp.json` (it names executables to run).
pub fn register(registry: &mut ToolRegistry, omnia_home: Option<PathBuf>, trusted: bool) {
    register_with(registry, Arc::new(LspManager::new(omnia_home, trusted)));
}

/// Registers tools from immutable configuration captured by the native trust
/// boundary. The snapshot remains scoped to its original workspace and cannot
/// authorize project executables for a subagent working in another root.
pub fn register_snapshot(
    registry: &mut ToolRegistry,
    omnia_home: Option<PathBuf>,
    workspace: &Path,
    specs: LoadedSpecs,
) {
    register_with(
        registry,
        Arc::new(LspManager::new(omnia_home, false).with_spec_snapshot(workspace, specs)),
    );
}

pub fn register_with(registry: &mut ToolRegistry, manager: Arc<LspManager>) {
    for kind in [
        Kind::Definition,
        Kind::References,
        Kind::Hover,
        Kind::Symbols,
        Kind::Diagnostics,
        Kind::Rename,
    ] {
        registry.register(Arc::new(LspTool {
            manager: Arc::clone(&manager),
            kind,
        }));
    }
}

type ClientKey = (String, String);

/// Owns the live language-server processes.
pub struct LspManager {
    omnia_home: Option<PathBuf>,
    trusted: bool,
    spec_snapshot: Option<(String, LoadedSpecs)>,
    path_dirs: Option<Vec<PathBuf>>,
    idle: Duration,
    clients: tokio::sync::Mutex<HashMap<ClientKey, Arc<LspClient>>>,
    reaper_started: AtomicBool,
}

impl LspManager {
    pub fn new(omnia_home: Option<PathBuf>, trusted: bool) -> Self {
        Self {
            omnia_home,
            trusted,
            spec_snapshot: None,
            path_dirs: None,
            idle: IDLE_SHUTDOWN,
            clients: Default::default(),
            reaper_started: AtomicBool::new(false),
        }
    }

    /// Pins all executable definitions, including an absent project config,
    /// so a file created or modified after approval cannot affect dispatch.
    pub fn with_spec_snapshot(mut self, workspace: &Path, specs: LoadedSpecs) -> Self {
        let root = std::fs::canonicalize(workspace).unwrap_or_else(|_| absolute(workspace));
        self.spec_snapshot = Some((path_key(&root), specs));
        self
    }

    pub fn with_idle_timeout(mut self, idle: Duration) -> Self {
        self.idle = idle;
        self
    }

    pub fn with_path_dirs(mut self, dirs: Vec<PathBuf>) -> Self {
        self.path_dirs = Some(dirs);
        self
    }

    fn dirs(&self) -> Vec<PathBuf> {
        self.path_dirs.clone().unwrap_or_else(config::path_dirs)
    }

    /// First available server for `ext`, or an explanatory error.
    fn launch_for(&self, cwd: &Path, ext: &str) -> Result<Launch, String> {
        let loaded = if let Some((root, specs)) = &self.spec_snapshot {
            let current = std::fs::canonicalize(cwd).map_err(|_| {
                "The LSP workspace no longer resolves to its trusted snapshot.".to_string()
            })?;
            if path_key(&current) != *root {
                return Err("The LSP configuration snapshot belongs to another workspace; capture and trust that workspace before starting its server.".into());
            }
            specs.clone()
        } else {
            config::load_specs(self.omnia_home.as_deref(), cwd, self.trusted)
        };
        let dirs = self.dirs();
        let candidates = config::specs_for_extension(&loaded.specs, ext);
        for spec in &candidates {
            if let Some(program) = config::resolve_command(&spec.command, &dirs) {
                return Ok(Launch {
                    name: spec.name.clone(),
                    program,
                    args: spec.args.clone(),
                    initialization_options: spec.initialization_options.clone(),
                });
            }
        }
        let tried: Vec<&str> = candidates.iter().map(|s| s.command.as_str()).collect();
        let mut message = if ext.is_empty() {
            "No language server handles files without an extension.".to_string()
        } else {
            format!("No language server found for `.{ext}` files.")
        };
        if !tried.is_empty() {
            message.push_str(&format!(" Not on PATH: {}.", tried.join(", ")));
        }
        message.push(' ');
        message.push_str(config::install_hint(ext));
        let home = self
            .omnia_home
            .as_ref()
            .map(|h| h.join("lsp.json").display().to_string())
            .unwrap_or_else(|| "<omnia_home>/lsp.json".into());
        message.push_str(&format!(
            "\nOr configure any server in {home}{}: {{\"servers\":{{\"name\":{{\"command\":\"...\",\"args\":[\"--stdio\"],\"extensions\":[\"{}\"]}}}}}}",
            if self.trusted { format!(" or {}", cwd.join(".omnia").join("lsp.json").display()) } else { String::new() },
            if ext.is_empty() { "ext" } else { ext },
        ));
        for warning in loaded.warnings {
            message.push_str(&format!("\nNote: {warning}"));
        }
        Err(message)
    }

    async fn client(
        self: &Arc<Self>,
        cwd: &Path,
        launch: Launch,
        cancel: &crate::CancellationToken,
    ) -> Result<Arc<LspClient>, LspError> {
        self.start_reaper();
        let key = (path_key(cwd), launch.name.clone());
        let mut clients = self.clients.lock().await;
        if let Some(existing) = clients.get(&key) {
            if existing.is_alive() {
                return Ok(Arc::clone(existing));
            }
            clients.remove(&key);
        }
        let started = LspClient::start(&launch, cwd, cancel).await?;
        clients.insert(key, Arc::clone(&started));
        Ok(started)
    }

    async fn running_for(&self, cwd: &Path) -> Vec<Arc<LspClient>> {
        let root = path_key(cwd);
        self.clients
            .lock()
            .await
            .iter()
            .filter(|((r, _), c)| *r == root && c.is_alive())
            .map(|(_, c)| Arc::clone(c))
            .collect()
    }

    /// Shuts down servers idle longer than the timeout. Returns how many.
    pub async fn sweep(&self) -> usize {
        let stale: Vec<Arc<LspClient>> = {
            let mut clients = self.clients.lock().await;
            let dead: Vec<ClientKey> = clients
                .iter()
                .filter(|(_, c)| !c.is_alive() || c.idle_for() >= self.idle)
                .map(|(k, _)| k.clone())
                .collect();
            dead.iter().filter_map(|k| clients.remove(k)).collect()
        };
        let count = stale.len();
        for client in stale {
            client.shutdown().await;
        }
        count
    }

    /// Number of live servers (for diagnostics and tests).
    pub async fn live_count(&self) -> usize {
        self.clients
            .lock()
            .await
            .values()
            .filter(|c| c.is_alive())
            .count()
    }

    fn start_reaper(self: &Arc<Self>) {
        if self.reaper_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak: Weak<Self> = Arc::downgrade(self);
        let period = (self.idle / 4).clamp(Duration::from_millis(200), Duration::from_secs(30));
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(period).await;
                let Some(manager) = weak.upgrade() else { break };
                manager.sweep().await;
            }
        });
    }
}

// ---- tools -----------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Definition,
    References,
    Hover,
    Symbols,
    Diagnostics,
    Rename,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Definition => "lsp_definition",
            Kind::References => "lsp_references",
            Kind::Hover => "lsp_hover",
            Kind::Symbols => "lsp_symbols",
            Kind::Diagnostics => "lsp_diagnostics",
            Kind::Rename => "lsp_rename",
        }
    }
}

struct LspTool {
    manager: Arc<LspManager>,
    kind: Kind,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Args {
    path: Option<String>,
    line: Option<u64>,
    column: Option<u64>,
    include_declaration: Option<bool>,
    query: Option<String>,
    new_name: Option<String>,
}

fn pos_props() -> Value {
    json!({
        "path": {"type": "string", "description": "File path (absolute or relative to the workspace)."},
        "line": {"type": "integer", "minimum": 1, "description": "1-based line, as shown by read_file."},
        "column": {"type": "integer", "minimum": 1, "description": "1-based character column within the line."}
    })
}

#[async_trait]
impl Tool for LspTool {
    fn spec(&self) -> ToolSpec {
        let (description, input_schema) = match self.kind {
            Kind::Definition => (
                "Go to definition via the language server (rust-analyzer, tsserver, pyright, gopls, clangd, ...). Position is 1-based line and column of a symbol usage. Returns file:line:col with a code snippet.",
                json!({"type":"object","properties":pos_props(),"required":["path","line","column"]}),
            ),
            Kind::References => {
                let mut props = pos_props();
                props["include_declaration"] = json!({"type":"boolean","description":"Include the declaration itself (default true)."});
                (
                    "Find all references to the symbol at a position via the language server. Semantic: unlike grep it ignores same-named unrelated symbols. Capped at 100 results.",
                    json!({"type":"object","properties":props,"required":["path","line","column"]}),
                )
            }
            Kind::Hover => (
                "Show type information and documentation for the symbol at a position via the language server.",
                json!({"type":"object","properties":pos_props(),"required":["path","line","column"]}),
            ),
            Kind::Symbols => (
                "List symbols. With `path`: the outline of that file (functions, types, methods with positions). With `query` (no path): search symbols by name across the workspace.",
                json!({"type":"object","properties":{
                    "path":{"type":"string","description":"File to outline."},
                    "query":{"type":"string","description":"Workspace-wide symbol name query (used when `path` is absent)."}}}),
            ),
            Kind::Diagnostics => (
                "Compiler/linter errors and warnings for a file as reported by the language server, with line:col and message.",
                json!({"type":"object","properties":{"path":{"type":"string","description":"File to check."}},"required":["path"]}),
            ),
            Kind::Rename => {
                let mut props = pos_props();
                props["new_name"] = json!({"type":"string","description":"New identifier for the symbol."});
                (
                    "Semantic rename of the symbol at a position across the workspace, applied to files on disk (checkpointed so it can be undone). Refuses edits that create/rename/delete files or touch files outside the workspace.",
                    json!({"type":"object","properties":props,"required":["path","line","column","new_name"]}),
                )
            }
        };
        ToolSpec {
            name: self.kind.name().into(),
            description: description.into(),
            input_schema,
        }
    }

    fn effect(&self) -> EffectClass {
        if self.kind == Kind::Rename {
            EffectClass::WriteWorkspace
        } else {
            EffectClass::ReadWorkspace
        }
    }

    fn describe(&self, input: &Value) -> String {
        let path = input.get("path").and_then(Value::as_str);
        let query = input.get("query").and_then(Value::as_str);
        let at = match (path, input.get("line").and_then(Value::as_u64)) {
            (Some(p), Some(l)) => format!(
                "{p}:{l}:{}",
                input.get("column").and_then(Value::as_u64).unwrap_or(1)
            ),
            (Some(p), None) => p.to_string(),
            _ => query.map(|q| format!("`{q}`")).unwrap_or_default(),
        };
        match self.kind {
            Kind::Rename => format!(
                "LSP rename at {at} to `{}`",
                input.get("new_name").and_then(Value::as_str).unwrap_or("?")
            ),
            kind => format!("{} {at}", kind.name()),
        }
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        let args: Args = match parse_input(input) {
            Ok(args) => args,
            Err(message) => return Ok(ToolOutput::error(message)),
        };
        match self.run(ctx, args).await {
            Ok(text) => Ok(ToolOutput::text(text)),
            Err(LspError::Cancelled) => Err(HarnessError::Cancelled),
            Err(LspError::Msg(message)) => Ok(ToolOutput::error(message)),
        }
    }
}

struct Session {
    client: Arc<LspClient>,
    path: PathBuf,
    doc: Doc,
}

struct Pos {
    line0: usize,
    utf16: usize,
}

impl LspTool {
    async fn run(&self, ctx: &ToolContext, args: Args) -> Result<String, LspError> {
        match self.kind {
            Kind::Symbols => match (&args.path, &args.query) {
                (Some(path), _) => self.document_symbols(ctx, path).await,
                (None, Some(query)) => self.workspace_symbols(ctx, query).await,
                (None, None) => {
                    Err("provide `path` (file outline) or `query` (workspace search)".into())
                }
            },
            Kind::Diagnostics => {
                let path = args.path.as_deref().ok_or("`path` is required")?;
                self.diagnostics(ctx, path).await
            }
            kind => {
                let path = args.path.as_deref().ok_or("`path` is required")?;
                let line = args
                    .line
                    .filter(|l| *l >= 1)
                    .ok_or("`line` must be >= 1 (1-based)")?;
                let column = args
                    .column
                    .filter(|c| *c >= 1)
                    .ok_or("`column` must be >= 1 (1-based)")?;
                if kind == Kind::Rename {
                    let new_name = args.new_name.as_deref().map(str::trim).unwrap_or("");
                    if new_name.is_empty() || new_name.chars().any(char::is_whitespace) {
                        return Err(
                            "`new_name` must be a non-empty identifier without whitespace".into(),
                        );
                    }
                }
                let session = self.open(ctx, path).await?;
                let pos = position(&session.doc.text, line, column)?;
                let params = json!({
                    "textDocument": {"uri": session.doc.uri},
                    "position": {"line": pos.line0, "character": pos.utf16},
                });
                match kind {
                    Kind::Definition => {
                        let reply = session
                            .client
                            .request("textDocument/definition", params, &ctx.cancel)
                            .await?;
                        let (lines, total) = format_locations(ctx, &reply, MAX_LOCATIONS);
                        if lines.is_empty() {
                            return Ok("No definition found.".into());
                        }
                        Ok(format!(
                            "{}\n{}",
                            plural(total, "definition"),
                            with_overflow(lines, total)
                        ))
                    }
                    Kind::References => {
                        let mut params = params;
                        params["context"] =
                            json!({"includeDeclaration": args.include_declaration.unwrap_or(true)});
                        let reply = session
                            .client
                            .request("textDocument/references", params, &ctx.cancel)
                            .await?;
                        let (lines, total) = format_locations(ctx, &reply, MAX_LOCATIONS);
                        if lines.is_empty() {
                            return Ok("No references found.".into());
                        }
                        Ok(format!(
                            "{}\n{}",
                            plural(total, "reference"),
                            with_overflow(lines, total)
                        ))
                    }
                    Kind::Hover => {
                        let reply = session
                            .client
                            .request("textDocument/hover", params, &ctx.cancel)
                            .await?;
                        let text = reply.get("contents").map(hover_text).unwrap_or_default();
                        if text.trim().is_empty() {
                            Ok("No hover information at this position.".into())
                        } else {
                            Ok(truncate(text.trim(), 4000))
                        }
                    }
                    Kind::Rename => {
                        let mut params = params;
                        params["newName"] = json!(args.new_name.clone().unwrap_or_default());
                        let reply = session
                            .client
                            .request("textDocument/rename", params, &ctx.cancel)
                            .await?;
                        if reply.is_null() {
                            return Err("the server returned no edits: no renamable symbol at this position".into());
                        }
                        apply_rename(ctx, &reply, args.new_name.as_deref().unwrap_or("")).await
                    }
                    Kind::Symbols | Kind::Diagnostics => unreachable!(),
                }
            }
        }
    }

    /// Resolves the file, starts (or reuses) the right server and syncs the file.
    async fn open(&self, ctx: &ToolContext, path: &str) -> Result<Session, LspError> {
        let path = absolute(&ctx.resolve(path));
        if !path.is_file() {
            return Err(LspError::Msg(format!("file not found: {}", path.display())));
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let launch = self
            .manager
            .launch_for(&ctx.cwd, &ext)
            .map_err(LspError::Msg)?;
        let client = self
            .manager
            .client(&absolute(&ctx.cwd), launch, &ctx.cancel)
            .await?;
        client.take_fresh_server();
        let doc = client
            .sync_document(&path, &config::language_id(&ext))
            .await?;
        Ok(Session { client, path, doc })
    }

    async fn diagnostics(&self, ctx: &ToolContext, path: &str) -> Result<String, LspError> {
        let path_buf = absolute(&ctx.resolve(path));
        if !path_buf.is_file() {
            return Err(LspError::Msg(format!(
                "file not found: {}",
                path_buf.display()
            )));
        }
        // Remember the generation first: didOpen/didChange triggers a new publish.
        let key = path_key(&path_buf);
        let ext = path_buf
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let launch = self
            .manager
            .launch_for(&ctx.cwd, &ext)
            .map_err(LspError::Msg)?;
        let client = self
            .manager
            .client(&absolute(&ctx.cwd), launch, &ctx.cancel)
            .await?;
        let server_was_fresh = client.take_fresh_server();
        let since = client.diagnostics_generation(&key);
        let doc = client
            .sync_document(&path_buf, &config::language_id(&ext))
            .await?;
        let budget = Duration::from_secs(if server_was_fresh { 25 } else { 8 });
        let items = client
            .wait_diagnostics(&doc.key, since, doc.fresh, budget, &ctx.cancel)
            .await?;
        let shown = display(ctx, &path_buf);
        let Some(items) = items else {
            return Ok(format!(
                "{shown}: the server published no diagnostics yet (it may still be indexing). Try again shortly."
            ));
        };
        let index = LineIndex::new(&doc.text);
        let mut rows: Vec<(usize, usize, String)> = Vec::new();
        let (mut errors, mut warnings, mut other) = (0, 0, 0);
        for item in &items {
            let severity = item.get("severity").and_then(Value::as_u64).unwrap_or(1);
            let label = match severity {
                1 => {
                    errors += 1;
                    "error"
                }
                2 => {
                    warnings += 1;
                    "warning"
                }
                _ => {
                    other += 1;
                    continue;
                }
            };
            let line = item
                .pointer("/range/start/line")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            let ch = item
                .pointer("/range/start/character")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            let col = utf16_to_char_col(index.line_text(line), ch) + 1;
            let code = match item.get("code") {
                Some(Value::String(s)) => format!("[{s}]"),
                Some(Value::Number(n)) => format!("[{n}]"),
                _ => String::new(),
            };
            let source = item
                .get("source")
                .and_then(Value::as_str)
                .map(|s| format!(" ({s})"))
                .unwrap_or_default();
            let message = truncate(
                item.get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim(),
                500,
            )
            .replace('\n', "\n    ");
            rows.push((
                line,
                col,
                format!("{shown}:{}:{col} {label}{code} {message}{source}", line + 1),
            ));
        }
        rows.sort_by_key(|(l, c, _)| (*l, *c));
        if rows.is_empty() {
            let note = if other > 0 {
                format!(" ({other} info/hint omitted)")
            } else {
                String::new()
            };
            return Ok(format!("{shown}: no errors or warnings{note}."));
        }
        let total = rows.len();
        let mut lines: Vec<String> = rows.into_iter().map(|(_, _, s)| s).collect();
        lines.truncate(MAX_DIAGNOSTICS);
        let mut out = format!(
            "{shown}: {errors} error(s), {warnings} warning(s)\n{}",
            lines.join("\n")
        );
        if total > MAX_DIAGNOSTICS {
            out.push_str(&format!("\n... {} more not shown", total - MAX_DIAGNOSTICS));
        }
        Ok(out)
    }

    async fn document_symbols(&self, ctx: &ToolContext, path: &str) -> Result<String, LspError> {
        let session = self.open(ctx, path).await?;
        let reply = session
            .client
            .request(
                "textDocument/documentSymbol",
                json!({"textDocument": {"uri": session.doc.uri}}),
                &ctx.cancel,
            )
            .await?;
        let items = reply.as_array().cloned().unwrap_or_default();
        if items.is_empty() {
            return Ok("No symbols found.".into());
        }
        let index = LineIndex::new(&session.doc.text);
        let mut lines = Vec::new();
        for item in &items {
            collect_document_symbol(item, 0, &index, &mut lines);
        }
        let total = lines.len();
        lines.truncate(MAX_SYMBOLS);
        let mut out = format!("{}:\n{}", display(ctx, &session.path), lines.join("\n"));
        if total > MAX_SYMBOLS {
            out.push_str(&format!("\n... {} more not shown", total - MAX_SYMBOLS));
        }
        Ok(out)
    }

    async fn workspace_symbols(&self, ctx: &ToolContext, query: &str) -> Result<String, LspError> {
        let cwd = absolute(&ctx.cwd);
        let mut clients = self.manager.running_for(&cwd).await;
        if clients.is_empty() {
            for (marker, ext) in [
                ("Cargo.toml", "rs"),
                ("tsconfig.json", "ts"),
                ("package.json", "ts"),
                ("go.mod", "go"),
                ("pyproject.toml", "py"),
                ("setup.py", "py"),
                ("requirements.txt", "py"),
                ("compile_commands.json", "cpp"),
                ("CMakeLists.txt", "cpp"),
            ] {
                if cwd.join(marker).exists() {
                    if let Ok(launch) = self.manager.launch_for(&cwd, ext) {
                        clients.push(self.manager.client(&cwd, launch, &ctx.cancel).await?);
                        break;
                    }
                }
            }
        }
        if clients.is_empty() {
            return Err("no language server is running for this workspace and none could be inferred from project files; run lsp_symbols with a `path`, or lsp_diagnostics on a source file, to start one".into());
        }
        let mut lines = Vec::new();
        let mut total = 0;
        for client in clients {
            let reply = client
                .request("workspace/symbol", json!({"query": query}), &ctx.cancel)
                .await?;
            for item in reply.as_array().cloned().unwrap_or_default() {
                total += 1;
                if lines.len() < MAX_LOCATIONS {
                    lines.push(format_workspace_symbol(ctx, &item));
                }
            }
        }
        if lines.is_empty() {
            return Ok(format!("No symbols matching `{query}`."));
        }
        Ok(format!(
            "{}\n{}",
            plural(total, "symbol"),
            with_overflow(lines, total)
        ))
    }
}

// ---- helpers ---------------------------------------------------------------

fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

fn display(ctx: &ToolContext, path: &Path) -> String {
    relative_to(&absolute(&ctx.cwd), path).unwrap_or_else(|| {
        path.to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches("//?/")
            .to_string()
    })
}

fn position(text: &str, line: u64, column: u64) -> Result<Pos, String> {
    let index = LineIndex::new(text);
    let line0 = (line - 1) as usize;
    if line0 >= index.line_count() {
        return Err(format!(
            "line {line} is out of range (file has {} lines)",
            index.line_count()
        ));
    }
    let content = index.line_text(line0);
    let char_col0 = (column - 1) as usize;
    let len = content.chars().count();
    if char_col0 > len {
        return Err(format!(
            "column {column} is out of range (line {line} has {len} characters)"
        ));
    }
    Ok(Pos {
        line0,
        utf16: char_col_to_utf16(content, char_col0),
    })
}

fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

fn with_overflow(mut lines: Vec<String>, total: usize) -> String {
    if total > lines.len() {
        lines.push(format!("... {} more not shown", total - lines.len()));
    }
    lines.join("\n")
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// Cache of file contents for rendering snippets.
#[derive(Default)]
struct Snippets(HashMap<String, Option<String>>);

impl Snippets {
    fn text(&mut self, path: &Path) -> Option<&String> {
        self.0
            .entry(path_key(path))
            .or_insert_with(|| {
                std::fs::read_to_string(path)
                    .ok()
                    .map(|t| t.trim_start_matches('\u{feff}').to_string())
            })
            .as_ref()
    }

    /// `path:line:col  snippet` for an LSP location.
    fn render(&mut self, ctx: &ToolContext, uri: &str, line: usize, utf16: usize) -> String {
        let Some(path) = uri_to_path(uri) else {
            return uri.to_string();
        };
        let shown = display(ctx, &path);
        let Some(text) = self.text(&path) else {
            return format!("{shown}:{}:{}", line + 1, utf16 + 1);
        };
        let index = LineIndex::new(text);
        let content = index.line_text(line);
        let col = utf16_to_char_col(content, utf16) + 1;
        format!(
            "{shown}:{}:{col}  {}",
            line + 1,
            truncate(content.trim(), 160)
        )
    }
}

/// Renders `Location | Location[] | LocationLink[]`; returns (lines, total).
fn format_locations(ctx: &ToolContext, reply: &Value, cap: usize) -> (Vec<String>, usize) {
    let items: Vec<&Value> = match reply {
        Value::Array(items) => items.iter().collect(),
        Value::Object(_) => vec![reply],
        _ => Vec::new(),
    };
    let mut snippets = Snippets::default();
    let mut lines = Vec::new();
    for item in &items {
        if lines.len() >= cap {
            break;
        }
        let uri = item
            .get("uri")
            .or_else(|| item.get("targetUri"))
            .and_then(Value::as_str);
        let range = item
            .get("range")
            .or_else(|| item.get("targetSelectionRange"))
            .or_else(|| item.get("targetRange"));
        let (Some(uri), Some(range)) = (uri, range) else {
            continue;
        };
        let line = range
            .pointer("/start/line")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let ch = range
            .pointer("/start/character")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        lines.push(snippets.render(ctx, uri, line, ch));
    }
    (lines, items.len())
}

const SYMBOL_KINDS: [&str; 26] = [
    "file",
    "module",
    "namespace",
    "package",
    "class",
    "method",
    "property",
    "field",
    "constructor",
    "enum",
    "interface",
    "function",
    "variable",
    "constant",
    "string",
    "number",
    "boolean",
    "array",
    "object",
    "key",
    "null",
    "enum-member",
    "struct",
    "event",
    "operator",
    "type-param",
];

fn symbol_kind(item: &Value) -> &'static str {
    item.get("kind")
        .and_then(Value::as_u64)
        .and_then(|k| SYMBOL_KINDS.get((k as usize).wrapping_sub(1)))
        .copied()
        .unwrap_or("symbol")
}

fn collect_document_symbol(item: &Value, depth: usize, index: &LineIndex, out: &mut Vec<String>) {
    let name = item.get("name").and_then(Value::as_str).unwrap_or("?");
    let range = item
        .get("selectionRange")
        .or_else(|| item.pointer("/location/range"))
        .or_else(|| item.get("range"));
    let at = range
        .map(|r| {
            let line = r
                .pointer("/start/line")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            let ch = r
                .pointer("/start/character")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            format!(
                "  {}:{}",
                line + 1,
                utf16_to_char_col(index.line_text(line), ch) + 1
            )
        })
        .unwrap_or_default();
    let detail = item
        .get("detail")
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty())
        .map(|d| format!("  {}", truncate(d, 80)))
        .unwrap_or_default();
    out.push(format!(
        "{}{} {name}{at}{detail}",
        "  ".repeat(depth),
        symbol_kind(item)
    ));
    for child in item
        .get("children")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        collect_document_symbol(child, depth + 1, index, out);
    }
}

fn format_workspace_symbol(ctx: &ToolContext, item: &Value) -> String {
    let name = item.get("name").and_then(Value::as_str).unwrap_or("?");
    let container = item
        .get("containerName")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        .map(|c| format!(" (in {c})"))
        .unwrap_or_default();
    let location = match item.get("location") {
        Some(loc) => match (loc.get("uri").and_then(Value::as_str), loc.get("range")) {
            (Some(uri), Some(range)) => {
                let line = range
                    .pointer("/start/line")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                let ch = range
                    .pointer("/start/character")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                Snippets::default().render(ctx, uri, line, ch)
            }
            (Some(uri), None) => uri_to_path(uri)
                .map(|p| display(ctx, &p))
                .unwrap_or_else(|| uri.to_string()),
            _ => String::new(),
        },
        None => String::new(),
    };
    format!("{} {name}{container}  {location}", symbol_kind(item))
}

fn hover_text(contents: &Value) -> String {
    match contents {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(hover_text)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        Value::Object(map) => {
            let value = map.get("value").and_then(Value::as_str).unwrap_or("");
            match map.get("language").and_then(Value::as_str) {
                Some(lang) => format!("```{lang}\n{value}\n```"),
                None => value.to_string(),
            }
        }
        _ => String::new(),
    }
}

// ---- rename ----------------------------------------------------------------

struct FilePlan {
    path: PathBuf,
    shown: String,
    old: String,
    new: String,
    bom: bool,
    edits: Vec<TextEdit>,
}

fn escape_snippet(text: &str) -> String {
    truncate(&text.replace('\r', "\\r").replace('\n', "\\n"), 40)
}

async fn apply_rename(ctx: &ToolContext, edit: &Value, new_name: &str) -> Result<String, LspError> {
    let files = parse_workspace_edit(edit)?;
    if files.is_empty() {
        return Err("the server returned an empty rename (nothing to change)".into());
    }
    let root = absolute(&ctx.cwd);
    let mut plans: Vec<FilePlan> = Vec::new();
    for file in &files {
        let path = uri_to_path(&file.uri)
            .ok_or_else(|| LspError::Msg(format!("unsupported URI in rename: {}", file.uri)))?;
        let inside = relative_to(&root, &path).is_some()
            || path
                .canonicalize()
                .ok()
                .is_some_and(|c| relative_to(&root, &c).is_some());
        if !inside {
            return Err(LspError::Msg(format!(
                "refusing rename: it would edit {} which is outside the workspace; nothing was changed",
                path.display()
            )));
        }
        if !path.is_file() {
            return Err(LspError::Msg(format!(
                "refusing rename: {} does not exist (the server asked to create it); nothing was changed",
                path.display()
            )));
        }
        let raw = tokio::fs::read(&path)
            .await
            .map_err(|e| LspError::Msg(format!("cannot read {}: {e}", path.display())))?;
        let raw = String::from_utf8(raw).map_err(|_| {
            LspError::Msg(format!(
                "{} is not valid UTF-8; nothing was changed",
                path.display()
            ))
        })?;
        let (bom, old) = match raw.strip_prefix('\u{feff}') {
            Some(rest) => (true, rest.to_string()),
            None => (false, raw),
        };
        let new = apply_text_edits(&old, &file.edits)
            .map_err(|e| LspError::Msg(format!("{}: {e}; nothing was changed", path.display())))?;
        plans.push(FilePlan {
            shown: display(ctx, &path),
            path,
            old,
            new,
            bom,
            edits: file.edits.clone(),
        });
    }
    plans.retain(|p| p.old != p.new);
    if plans.is_empty() {
        return Ok(format!("Rename to `{new_name}` produced no changes."));
    }
    for plan in &plans {
        ctx.checkpoint_before(&plan.path).map_err(|e| {
            LspError::Msg(format!(
                "checkpoint failed for {}: {e}; nothing was changed",
                plan.shown
            ))
        })?;
    }
    let mut written = Vec::new();
    for plan in &plans {
        let mut content = String::new();
        if plan.bom {
            content.push('\u{feff}');
        }
        content.push_str(&plan.new);
        if let Err(error) = tokio::fs::write(&plan.path, content).await {
            return Err(LspError::Msg(format!(
                "failed writing {}: {error}. Already rewritten: [{}]",
                plan.shown,
                written.join(", ")
            )));
        }
        written.push(plan.shown.clone());
    }
    let total_edits: usize = plans.iter().map(|p| p.edits.len()).sum();
    let mut out = format!(
        "Renamed to `{new_name}`: {} in {}.\n",
        plural(total_edits, "edit"),
        plural(plans.len(), "file")
    );
    let mut shown_lines = 0;
    'files: for plan in &plans {
        let index = LineIndex::new(&plan.old);
        let mut edits = plan.edits.clone();
        edits.sort_by_key(|e| e.start);
        for edit in &edits {
            if shown_lines >= 60 {
                out.push_str(&format!(
                    "... {} more edits not shown\n",
                    total_edits - shown_lines
                ));
                break 'files;
            }
            let (s, e) = (
                index.offset(edit.start.0, edit.start.1),
                index.offset(edit.end.0, edit.end.1),
            );
            let col = utf16_to_char_col(index.line_text(edit.start.0), edit.start.1) + 1;
            out.push_str(&format!(
                "{}:{}:{col}  `{}` -> `{}`\n",
                plan.shown,
                edit.start.0 + 1,
                escape_snippet(plan.old.get(s..e.max(s)).unwrap_or("")),
                escape_snippet(&edit.new_text)
            ));
            shown_lines += 1;
        }
    }
    out.push_str("Files were modified on disk; re-read them before further edits.");
    Ok(out)
}

#[cfg(test)]
mod tests;
