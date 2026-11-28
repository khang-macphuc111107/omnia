//! Lazy-Spawned Language Server Client (Rust/Python/TS/Go/C++) with JobObject Cleanup,
//! Strict UTF-16 Code-Unit Positioning, Live Diagnostics (`publishDiagnostics` + pull),
//! and `textDocument/rename` `WorkspaceEdit` Execution.
//!
//! Spawns zero background LSP processes at startup (`0 ms` overhead). Only starts a server
//! lazily when `lsp_query` or post-edit immediate diagnostics explicitly request it.

use crate::ast_edit::{AstLang, count_syntax_errors};
use crate::graph_locator::WorkspaceGraphIndex;
use crate::path_guard::ensure_within_workspace;
use crate::supervisor::{spawn_supervised_command, ProcessSupervisor};
use anyhow::{bail, Context, Result};
use omnia_core::{
    lsp_utf16_to_utf8_line_col, utf16_unit_to_utf8_byte_offset, utf8_byte_offset_to_utf16_unit,
    utf8_line_col_to_lsp_utf16,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};

/// Cold-start timeout for the first request after spawning a language server (indexing headroom).
pub const LSP_FIRST_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Warm steady-state request timeout after the language server has served its first request.
pub const LSP_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Handshake timeout for `initialize`.
const LSP_INITIALIZE_TIMEOUT: Duration = Duration::from_secs(15);
/// Idle reaper threshold shutting down unused language servers after 10 minutes.
pub const LSP_IDLE_SHUTDOWN: Duration = Duration::from_secs(10 * 60);
/// Maximum bounded retry attempts on LSP busy errors (`-32801` / `-32802`).
const LSP_BUSY_RETRY_MAX: usize = 8;
/// Backoff interval between retries when the server reports `ContentModified` / `ServerCancelled`.
const LSP_BUSY_RETRY_STEP: Duration = Duration::from_millis(400);
/// Quiet window used to settle rapid `publishDiagnostics` bursts before returning.
const LSP_DIAG_SETTLE_QUIET: Duration = Duration::from_millis(120);
/// LSP JSON-RPC error code: `ContentModified`.
const LSP_ERR_CONTENT_MODIFIED: i64 = -32801;
/// LSP JSON-RPC error code: `ServerCancelled`.
const LSP_ERR_SERVER_CANCELLED: i64 = -32802;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LspLanguage {
    Rust,
    Python,
    TypeScript,
    Go,
    Cpp,
}

impl LspLanguage {
    #[must_use]
    pub fn from_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "rs" => Some(Self::Rust),
            "py" | "pyi" => Some(Self::Python),
            "ts" | "tsx" | "js" | "jsx" | "mts" | "cts" | "mjs" | "cjs" => Some(Self::TypeScript),
            "go" => Some(Self::Go),
            "c" | "h" | "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh" => Some(Self::Cpp),
            _ => None,
        }
    }

    #[must_use]
    pub fn language_id(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::Python => "python",
            Self::TypeScript => "typescript",
            Self::Go => "go",
            Self::Cpp => "cpp",
        }
    }

    #[must_use]
    pub fn candidate_commands(self) -> &'static [(&'static str, &'static [&'static str])] {
        match self {
            Self::Rust => &[("rust-analyzer", &[])],
            Self::Python => &[
                ("pyright-langserver", &["--stdio"]),
                ("basedpyright-langserver", &["--stdio"]),
                ("pylsp", &[]),
            ],
            Self::TypeScript => &[("typescript-language-server", &["--stdio"])],
            Self::Go => &[("gopls", &["serve"])],
            Self::Cpp => &[("clangd", &[])],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspQueryResult {
    pub mode: String,
    pub server: String,
    pub locations: Vec<LspLocation>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspLocation {
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspDiagnosticItem {
    pub severity: String,
    pub line: usize,
    pub column: usize,
    pub message: String,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspRenameOutcome {
    pub mode: String,
    pub server: String,
    pub files_modified: Vec<String>,
    pub edits_applied: usize,
    pub summary: String,
}

#[derive(Default)]
struct DiagStore {
    generation: u64,
    by_uri: HashMap<String, (u64, Vec<LspDiagnosticItem>)>,
}

impl DiagStore {
    fn publish(&mut self, uri_key: String, items: Vec<LspDiagnosticItem>) -> u64 {
        self.generation = self.generation.saturating_add(1);
        let next_gen = self.generation;
        self.by_uri.insert(uri_key, (next_gen, items));
        next_gen
    }

    fn current_generation(&self, uri_key: &str) -> u64 {
        self.by_uri.get(uri_key).map_or(0, |(g, _)| *g)
    }

    fn items_for(&self, uri_key: &str) -> Vec<LspDiagnosticItem> {
        self.by_uri
            .get(uri_key)
            .map(|(_, items)| items.clone())
            .unwrap_or_default()
    }
}

/// Builds a JSON-RPC 2.0 response for a server-to-client LSP request so servers such as
/// `rust-analyzer`, `pyright`, `gopls`, or `typescript-language-server` never deadlock on
/// `workspace/configuration`, capability registration, progress creation, or refresh calls.
fn build_server_request_reply(
    id: &Value,
    method: &str,
    params: Option<&Value>,
    root_uri: &str,
) -> Value {
    match method {
        "workspace/configuration" => {
            let count = params
                .and_then(|p| p.get("items"))
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let nulls = vec![Value::Null; count];
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": nulls,
            })
        }
        "client/registerCapability"
        | "client/unregisterCapability"
        | "window/workDoneProgress/create"
        | "workspace/diagnostic/refresh"
        | "workspace/inlayHint/refresh"
        | "workspace/semanticTokens/refresh"
        | "workspace/codeLens/refresh" => {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": Value::Null,
            })
        }
        "workspace/workspaceFolders" => {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": [{ "uri": root_uri, "name": "workspace" }],
            })
        }
        _ => {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32601,
                    "message": format!("Method not found: {method}"),
                },
            })
        }
    }
}

/// Returns `true` when an LSP JSON-RPC error represents a transient busy state (`-32801` / `-32802`).
#[must_use]
fn is_retryable_busy_error(err: &Value) -> bool {
    matches!(
        err.get("code").and_then(Value::as_i64),
        Some(LSP_ERR_CONTENT_MODIFIED | LSP_ERR_SERVER_CANCELLED)
    )
}

/// Builds the LSP `$/cancelRequest` notification emitted when a pending client request times out.
#[must_use]
fn build_cancel_notification(id: i64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "$/cancelRequest",
        "params": { "id": id },
    })
}

/// Waits on `diag_signal` until `uri_key` receives a generation strictly greater than `since_gen`
/// and then settles through rapid diagnostic bursts until `settle_quiet` elapses or `wait_budget` expires.
fn wait_diagnostics_settled(
    diag_signal: &(Mutex<DiagStore>, Condvar),
    uri_key: &str,
    since_gen: u64,
    wait_budget: Duration,
    settle_quiet: Duration,
) -> Vec<LspDiagnosticItem> {
    let deadline = Instant::now() + wait_budget;
    let (lock, cvar) = diag_signal;
    let Ok(mut store) = lock.lock() else {
        return Vec::new();
    };

    // Phase 1: wait for first publication newer than `since_gen`.
    while store.current_generation(uri_key) <= since_gen {
        let now = Instant::now();
        if now >= deadline {
            return store.items_for(uri_key);
        }
        let rem = deadline.saturating_duration_since(now);
        match cvar.wait_timeout(store, rem) {
            Ok((guard, _)) => store = guard,
            Err(_) => return Vec::new(),
        }
    }

    // Phase 2: settle burst publications until a quiet window passes without newer updates.
    let mut observed_gen = store.current_generation(uri_key);
    loop {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let step = settle_quiet.min(deadline.saturating_duration_since(now));
        if step.is_zero() {
            break;
        }
        match cvar.wait_timeout(store, step) {
            Ok((guard, _)) => {
                store = guard;
                let cur_gen = store.current_generation(uri_key);
                if cur_gen > observed_gen {
                    observed_gen = cur_gen;
                    continue;
                }
                break;
            }
            Err(_) => return Vec::new(),
        }
    }

    store.items_for(uri_key)
}

struct LiveLspClient {
    server_name: String,
    lang: LspLanguage,
    _workspace_root: PathBuf,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<i64, std::sync::mpsc::Sender<Value>>>>,
    diagnostics: Arc<(Mutex<DiagStore>, Condvar)>,
    doc_versions: Mutex<HashMap<String, i32>>,
    next_id: AtomicI64,
    served_request: AtomicBool,
    last_used: Mutex<Instant>,
    shutting_down: AtomicBool,
    _child: Mutex<Child>,
    supervisor: ProcessSupervisor,
}

impl Drop for LiveLspClient {
    fn drop(&mut self) {
        self.supervisor.kill_tree();
    }
}

impl LiveLspClient {
    fn spawn(
        lang: LspLanguage,
        exe: &str,
        args: &[&str],
        workspace_root: &Path,
    ) -> Result<Arc<Self>> {
        let mut cmd = Command::new(exe);
        cmd.args(args)
            .current_dir(workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        let (mut child, supervisor) = spawn_supervised_command(&mut cmd)
            .with_context(|| format!("failed to spawn LSP `{exe}`"))?;
        let stdin = Arc::new(Mutex::new(child.stdin.take().context("LSP missing stdin")?));
        let stdout = child.stdout.take().context("LSP missing stdout")?;

        let pending: Arc<Mutex<HashMap<i64, std::sync::mpsc::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let diagnostics: Arc<(Mutex<DiagStore>, Condvar)> =
            Arc::new((Mutex::new(DiagStore::default()), Condvar::new()));

        let root_uri = path_to_file_uri(workspace_root);
        let pending_reader = Arc::clone(&pending);
        let diags_reader = Arc::clone(&diagnostics);
        let stdin_reader = Arc::clone(&stdin);
        let root_uri_reader = root_uri.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some(msg)) = read_lsp_message(&mut reader) {
                let method_opt = msg.get("method").and_then(Value::as_str);
                let id_opt = msg.get("id");

                // Server-to-client request: carries BOTH `id` and `method`.
                if let (Some(req_id), Some(method)) = (id_opt, method_opt) {
                    let reply = build_server_request_reply(
                        req_id,
                        method,
                        msg.get("params"),
                        &root_uri_reader,
                    );
                    let _ = write_lsp_message(&stdin_reader, &reply);
                    continue;
                }

                // Response to a client-initiated request.
                if let Some(id) = id_opt.and_then(Value::as_i64) {
                    if let Ok(mut map) = pending_reader.lock() {
                        if let Some(tx) = map.remove(&id) {
                            let _ = tx.send(msg);
                        }
                    }
                    continue;
                }

                // Server notification (`textDocument/publishDiagnostics`).
                if method_opt == Some("textDocument/publishDiagnostics") {
                    if let Some(params) = msg.get("params") {
                        let uri = params.get("uri").and_then(Value::as_str).unwrap_or("");
                        if !uri.is_empty() {
                            let key = normalize_uri_key(uri);
                            let items = parse_lsp_diagnostics(params.get("diagnostics"));
                            let (lock, cvar) = &*diags_reader;
                            if let Ok(mut g) = lock.lock() {
                                g.publish(key, items);
                                cvar.notify_all();
                            }
                        }
                    }
                }
            }
        });

        let client = Arc::new(Self {
            server_name: exe.to_owned(),
            lang,
            _workspace_root: workspace_root.to_path_buf(),
            stdin,
            pending,
            diagnostics,
            doc_versions: Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            served_request: AtomicBool::new(false),
            last_used: Mutex::new(Instant::now()),
            shutting_down: AtomicBool::new(false),
            _child: Mutex::new(child),
            supervisor,
        });

        let _ = client.request_once(
            "initialize",
            &json!({
                "processId": std::process::id(),
                "rootUri": root_uri,
                "workspaceFolders": [{ "uri": root_uri, "name": "workspace" }],
                "capabilities": {
                    "workspace": {
                        "configuration": true,
                        "workspaceFolders": true
                    },
                    "window": {
                        "workDoneProgress": true
                    },
                    "textDocument": {
                        "definition": { "dynamicRegistration": false },
                        "references": { "dynamicRegistration": false },
                        "hover": { "contentFormat": ["plaintext", "markdown"] },
                        "documentSymbol": { "hierarchicalDocumentSymbolSupport": true },
                        "rename": { "prepareSupport": false },
                        "publishDiagnostics": { "versionSupport": true },
                        "diagnostic": { "dynamicRegistration": false }
                    }
                }
            }),
            LSP_INITIALIZE_TIMEOUT,
        )?;
        client.notify("initialized", json!({}))?;
        Ok(client)
    }

    fn touch(&self) {
        if let Ok(mut ts) = self.last_used.lock() {
            *ts = Instant::now();
        }
    }

    fn idle_elapsed(&self) -> Duration {
        self.last_used
            .lock()
            .map(|ts| ts.elapsed())
            .unwrap_or(Duration::ZERO)
    }

    fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = self.request_once("shutdown", &Value::Null, Duration::from_millis(1_500));
        let _ = self.notify("exit", Value::Null);
    }

    fn request_once(&self, method: &str, params: &Value, timeout: Duration) -> Result<Value> {
        self.touch();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = std::sync::mpsc::channel();
        if let Ok(mut map) = self.pending.lock() {
            map.insert(id, tx);
        }
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(err) = write_lsp_message(&self.stdin, &body) {
            if let Ok(mut map) = self.pending.lock() {
                map.remove(&id);
            }
            return Err(err);
        }
        match rx.recv_timeout(timeout) {
            Ok(resp) => Ok(resp),
            Err(err) => {
                if let Ok(mut map) = self.pending.lock() {
                    map.remove(&id);
                }
                let _ = write_lsp_message(&self.stdin, &build_cancel_notification(id));
                Err(anyhow::anyhow!(
                    "LSP `{method}` timed out after {:?}: {err}",
                    timeout
                ))
            }
        }
    }

    fn request(&self, method: &str, params: Value, override_timeout: Option<Duration>) -> Result<Value> {
        let budget = override_timeout.unwrap_or_else(|| {
            if self.served_request.load(Ordering::Acquire) {
                LSP_REQUEST_TIMEOUT
            } else {
                LSP_FIRST_REQUEST_TIMEOUT
            }
        });
        let deadline = Instant::now() + budget;

        for attempt in 0..LSP_BUSY_RETRY_MAX {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                bail!("LSP `{method}` exceeded deadline ({:?}) after {attempt} retry(s)", budget);
            }
            let resp = self.request_once(method, &params, remaining)?;
            if let Some(err) = resp.get("error") {
                if is_retryable_busy_error(err) && attempt + 1 < LSP_BUSY_RETRY_MAX {
                    let sleep_for = LSP_BUSY_RETRY_STEP
                        .min(deadline.saturating_duration_since(Instant::now()));
                    if !sleep_for.is_zero() {
                        std::thread::sleep(sleep_for);
                        continue;
                    }
                }
                bail!("LSP `{method}` error: {err}");
            }
            self.served_request.store(true, Ordering::Release);
            self.touch();
            return Ok(resp.get("result").cloned().unwrap_or(Value::Null));
        }

        bail!("LSP `{method}` exhausted {LSP_BUSY_RETRY_MAX} busy-retry attempts")
    }

    fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.touch();
        let body = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        write_lsp_message(&self.stdin, &body)
    }

    fn sync_document(&self, path: &Path, text: &str) -> Result<String> {
        self.touch();
        let uri = path_to_file_uri(path);
        let key = normalize_uri_key(&uri);
        let mut versions = self
            .doc_versions
            .lock()
            .map_err(|_| anyhow::anyhow!("LSP doc_versions poisoned"))?;
        if let Some(ver) = versions.get_mut(&key) {
            *ver += 1;
            let next_v = *ver;
            drop(versions);
            self.notify(
                "textDocument/didChange",
                json!({
                    "textDocument": { "uri": uri, "version": next_v },
                    "contentChanges": [{ "text": text }],
                }),
            )?;
            let _ = self.notify(
                "textDocument/didSave",
                json!({
                    "textDocument": { "uri": uri },
                    "text": text,
                }),
            );
        } else {
            versions.insert(key, 1);
            drop(versions);
            self.notify(
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": self.lang.language_id(),
                        "version": 1,
                        "text": text
                    }
                }),
            )?;
        }
        Ok(uri)
    }

    fn query_diagnostics(
        &self,
        path: &Path,
        text: &str,
        wait_ms: u64,
    ) -> Result<Vec<LspDiagnosticItem>> {
        let pre_uri = path_to_file_uri(path);
        let key = normalize_uri_key(&pre_uri);
        let since_gen = self
            .diagnostics
            .0
            .lock()
            .map(|g| g.current_generation(&key))
            .unwrap_or(0);

        let uri = self.sync_document(path, text)?;
        // Try LSP 3.17 pull diagnostic first cleanly.
        if let Ok(pull) = self.request(
            "textDocument/diagnostic",
            json!({ "textDocument": { "uri": uri } }),
            Some(Duration::from_millis(wait_ms.clamp(200, 2_500))),
        ) {
            if let Some(items) = pull.get("items").and_then(Value::as_array) {
                return Ok(parse_lsp_diagnostics(Some(&Value::Array(items.clone()))));
            }
        }
        // Fallback: wait on Condvar generation counter + settle rapid push bursts cleanly.
        Ok(wait_diagnostics_settled(
            &self.diagnostics,
            &key,
            since_gen,
            Duration::from_millis(wait_ms.clamp(150, 2_500)),
            LSP_DIAG_SETTLE_QUIET,
        ))
    }
}

/// Manager lazily starting language servers on demand, keeping cold startup at `0 ms`.
#[derive(Clone)]
pub struct LazyLspManager {
    workspace_root: PathBuf,
    clients: Arc<Mutex<HashMap<LspLanguage, Arc<LiveLspClient>>>>,
    reaper_started: Arc<AtomicBool>,
}

impl std::fmt::Debug for LazyLspManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let active = self.clients.lock().map(|g| g.len()).unwrap_or(0);
        f.debug_struct("LazyLspManager")
            .field("workspace_root", &self.workspace_root)
            .field("active_clients", &active)
            .finish()
    }
}

impl LazyLspManager {
    /// Construct manager with zero spawned processes and zero background threads (`0 ms` startup).
    #[must_use]
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            workspace_root,
            clients: Arc::new(Mutex::new(HashMap::new())),
            reaper_started: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Detects the first available language server binary on PATH for `lang`.
    #[must_use]
    pub fn detect_binary(lang: LspLanguage) -> Option<(&'static str, &'static [&'static str])> {
        for &(exe, args) in lang.candidate_commands() {
            if which::which(exe).is_ok() {
                return Some((exe, args));
            }
        }
        None
    }

    fn ensure_idle_reaper(&self) {
        if self
            .reaper_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let weak_clients: Weak<Mutex<HashMap<LspLanguage, Arc<LiveLspClient>>>> =
            Arc::downgrade(&self.clients);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(60));
            let Some(clients) = weak_clients.upgrade() else {
                break;
            };
            let _ = sweep_idle_clients(&clients, LSP_IDLE_SHUTDOWN);
        });
    }

    /// Shuts down and evicts any language server idle for at least `max_idle`.
    #[must_use]
    pub fn sweep_idle(&self, max_idle: Duration) -> usize {
        sweep_idle_clients(&self.clients, max_idle)
    }

    /// Politely shuts down every active language server managed by this instance.
    pub fn shutdown_all(&self) {
        let drained: Vec<Arc<LiveLspClient>> = match self.clients.lock() {
            Ok(mut guard) => guard.drain().map(|(_, c)| c).collect(),
            Err(_) => Vec::new(),
        };
        for client in drained {
            client.shutdown();
        }
    }

    fn get_or_spawn(&self, lang: LspLanguage) -> Option<Arc<LiveLspClient>> {
        if let Ok(guard) = self.clients.lock() {
            if let Some(existing) = guard.get(&lang) {
                existing.touch();
                return Some(Arc::clone(existing));
            }
        }
        let (exe, args) = Self::detect_binary(lang)?;
        let client = LiveLspClient::spawn(lang, exe, args, &self.workspace_root).ok()?;
        if let Ok(mut guard) = self.clients.lock() {
            guard.insert(lang, Arc::clone(&client));
        }
        self.ensure_idle_reaper();
        Some(client)
    }

    /// Queries `definition`, `references`, `hover`, `symbols`, or `diagnostics` via live LSP
    /// (w/ UTF-16 code-unit columns) and graceful Tree-sitter/AST graph fallback when offline.
    pub async fn query(
        &self,
        action: &str,
        rel_path: &str,
        line_1based: u32,
        char_0based: u32,
        symbol_hint: Option<&str>,
        graph: &Arc<Mutex<WorkspaceGraphIndex>>,
    ) -> LspQueryResult {
        if matches!(action, "diagnostics" | "diag") {
            if let Ok(abs) = ensure_within_workspace(&self.workspace_root, rel_path) {
                let diags = self.diagnostics_for_file(&abs, 600);
                let locations = diags
                    .iter()
                    .map(|d| LspLocation {
                        file: rel_path.to_owned(),
                        line: d.line,
                        column: d.column,
                        preview: format!("[{}] {}", d.severity, d.message),
                    })
                    .collect::<Vec<_>>();
                let summary = if locations.is_empty() {
                    format!("0 diagnostics in {rel_path}")
                } else {
                    locations
                        .iter()
                        .take(12)
                        .map(|l| format!("L{}:{} {}", l.line, l.column, l.preview))
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                return LspQueryResult {
                    mode: "lsp_diagnostics".into(),
                    server: LspLanguage::from_path(&abs)
                        .and_then(Self::detect_binary)
                        .map_or("tree-sitter", |(e, _)| e)
                        .into(),
                    locations,
                    summary,
                };
            }
        }

        if let Ok(abs) = ensure_within_workspace(&self.workspace_root, rel_path) {
            if let Some(lang) = LspLanguage::from_path(&abs) {
                if let Some(client) = self.get_or_spawn(lang) {
                    if let Ok(text) = std::fs::read_to_string(&abs) {
                        if let Ok(uri) = client.sync_document(&abs, &text) {
                            let lsp_pos = utf8_line_col_to_lsp_utf16(
                                &text,
                                line_1based.saturating_sub(1) as usize,
                                char_0based as usize,
                            );
                            let pos = json!({ "line": lsp_pos.0, "character": lsp_pos.1 });
                            let method = match action {
                                "references" => "textDocument/references",
                                "hover" => "textDocument/hover",
                                "symbols" | "document_symbol" | "document_symbols" => {
                                    "textDocument/documentSymbol"
                                }
                                _ => "textDocument/definition",
                            };
                            let params = match action {
                                "references" => json!({
                                    "textDocument": { "uri": uri },
                                    "position": pos,
                                    "context": { "includeDeclaration": true }
                                }),
                                "symbols" | "document_symbol" | "document_symbols" => {
                                    json!({ "textDocument": { "uri": uri } })
                                }
                                _ => json!({
                                    "textDocument": { "uri": uri },
                                    "position": pos
                                }),
                            };
                            if let Ok(raw) = client.request(method, params, None) {
                                if action == "hover" {
                                    let hover_txt = extract_hover_text(&raw);
                                    return LspQueryResult {
                                        mode: "live_lsp_hover".into(),
                                        server: client.server_name.clone(),
                                        locations: Vec::new(),
                                        summary: hover_txt,
                                    };
                                }
                                let locations = parse_lsp_locations(&raw, &self.workspace_root);
                                if !locations.is_empty()
                                    || !matches!(
                                        action,
                                        "symbols" | "document_symbol" | "document_symbols"
                                    )
                                {
                                    return LspQueryResult {
                                        mode: "live_lsp".into(),
                                        server: client.server_name.clone(),
                                        summary: format!(
                                            "{} result(s) from {}",
                                            locations.len(),
                                            client.server_name
                                        ),
                                        locations,
                                    };
                                }
                            }
                        }
                    }
                }
            }
        }

        if let Ok(idx) = graph.lock() {
            return self.fallback_ast_query(&idx, action, rel_path, symbol_hint);
        }
        LspQueryResult {
            mode: format!("ast_fallback:{action}"),
            server: "tree-sitter-workspace-graph".into(),
            summary: "workspace graph lock unavailable".into(),
            locations: Vec::new(),
        }
    }

    /// Collects live LSP diagnostics (`textDocument/diagnostic` + `publishDiagnostics`)
    /// plus Tree-sitter syntax errors for `abs_path` within `wait_ms`.
    #[must_use]
    pub fn diagnostics_for_file(&self, abs_path: &Path, wait_ms: u64) -> Vec<LspDiagnosticItem> {
        let Ok(text) = std::fs::read_to_string(abs_path) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if let Some(ast_lang) = AstLang::from_path(abs_path) {
            if let Ok(errs) = count_syntax_errors(ast_lang, &text) {
                if errs > 0 {
                    out.push(LspDiagnosticItem {
                        severity: "error".into(),
                        line: 1,
                        column: 1,
                        message: format!(
                            "Tree-sitter ({}) detected {errs} syntax error node(s)",
                            ast_lang.as_str()
                        ),
                        source: Some("tree-sitter".into()),
                    });
                }
            }
        }
        if let Some(lang) = LspLanguage::from_path(abs_path) {
            if let Some(client) = self.get_or_spawn(lang) {
                if let Ok(lsp_diags) = client.query_diagnostics(abs_path, &text, wait_ms) {
                    out.extend(lsp_diags);
                }
            }
        }
        out
    }

    /// Executes `textDocument/rename` across the workspace using strict UTF-16 offsets,
    /// returning modified files (applying atomically when `apply = true`).
    pub fn rename_symbol(
        &self,
        rel_path: &str,
        line_1based: usize,
        col_1based: usize,
        new_name: &str,
        apply: bool,
    ) -> Result<LspRenameOutcome> {
        if new_name.trim().is_empty() {
            bail!("rename `new_name` must not be empty");
        }
        let abs = ensure_within_workspace(&self.workspace_root, rel_path)?;
        let lang = LspLanguage::from_path(&abs)
            .ok_or_else(|| anyhow::anyhow!("unsupported LSP language for `{rel_path}`"))?;
        let Some(client) = self.get_or_spawn(lang) else {
            bail!(
                "no live LSP binary installed for {:?} to execute `textDocument/rename`",
                lang
            );
        };
        let text = std::fs::read_to_string(&abs)?;
        let uri = client.sync_document(&abs, &text)?;
        let lsp_pos = utf8_line_col_to_lsp_utf16(
            &text,
            line_1based.saturating_sub(1),
            col_1based.saturating_sub(1),
        );
        let ws_edit = client.request(
            "textDocument/rename",
            json!({
                "textDocument": { "uri": uri },
                "position": { "line": lsp_pos.0, "character": lsp_pos.1 },
                "newName": new_name,
            }),
            None,
        )?;

        let mut edits_by_file: WorkspaceEditsMap = BTreeMap::new();
        collect_workspace_edits(&ws_edit, &self.workspace_root, &mut edits_by_file)?;

        let mut files_modified = Vec::new();
        let mut total_edits = 0usize;

        for (file_path, mut edits) in edits_by_file {
            if edits.is_empty() {
                continue;
            }
            let rel_out = file_path
                .strip_prefix(&self.workspace_root)
                .unwrap_or(&file_path)
                .to_string_lossy()
                .replace('\\', "/");
            if apply {
                let raw = std::fs::read_to_string(&file_path)?;
                let preserve_bom = raw.starts_with('\u{FEFF}');
                let mut byte_edits: Vec<(usize, usize, String)> = edits
                    .drain(..)
                    .map(|(sl, sc, el, ec, txt)| {
                        let s_off = line_utf16_col_to_byte(&raw, sl as usize, sc as usize);
                        let e_off = line_utf16_col_to_byte(&raw, el as usize, ec as usize);
                        (s_off.min(e_off), s_off.max(e_off), txt)
                    })
                    .collect();
                byte_edits.sort_by_key(|b| std::cmp::Reverse(b.0));
                let mut updated = raw;
                for (s, e, replacement) in byte_edits {
                    updated.replace_range(s..e, &replacement);
                    total_edits += 1;
                }
                crate::sanitizer::atomic_write_bom_free(&file_path, &updated, preserve_bom)?;
            } else {
                total_edits += edits.len();
            }
            files_modified.push(rel_out);
        }

        Ok(LspRenameOutcome {
            mode: if apply { "applied" } else { "preview" }.into(),
            server: client.server_name.clone(),
            summary: format!(
                "{} {} edit(s) across {} file(s) via {}",
                if apply { "Applied" } else { "Previewed" },
                total_edits,
                files_modified.len(),
                client.server_name
            ),
            files_modified,
            edits_applied: total_edits,
        })
    }

    fn fallback_ast_query(
        &self,
        graph: &WorkspaceGraphIndex,
        action: &str,
        rel_path: &str,
        symbol: Option<&str>,
    ) -> LspQueryResult {
        let query = symbol.unwrap_or("").trim();
        let mut locations = Vec::new();
        if matches!(
            action,
            "symbols" | "document_symbol" | "document_symbols"
        ) || (query.is_empty() && !rel_path.trim().is_empty())
        {
            let norm_rel = rel_path
                .trim()
                .replace('\\', "/")
                .trim_start_matches("./")
                .to_owned();
            let entry = graph.parsed_asts().get(&norm_rel).or_else(|| {
                graph
                    .parsed_asts()
                    .iter()
                    .find(|(k, _)| {
                        k.eq_ignore_ascii_case(&norm_rel) || k.ends_with(&norm_rel)
                    })
                    .map(|(_, v)| v)
            });
            if let Some(f) = entry {
                for s in &f.symbols {
                    locations.push(LspLocation {
                        file: norm_rel.clone(),
                        line: s.start_line as usize,
                        column: 1,
                        preview: format!("{:?} `{}` — {}", s.kind, s.name, s.signature),
                    });
                }
            }
        }
        if !query.is_empty() && locations.is_empty() {
            let ppr = graph.compute_ppr_map(Some(query));
            let query_l = query.to_ascii_lowercase();
            let mut ranked: Vec<(f64, &String, &crate::graph_locator::ParsedFileAst)> = graph
                .parsed_asts()
                .iter()
                .filter(|(_, f)| {
                    f.symbols.iter().any(|s| {
                        s.name.eq_ignore_ascii_case(query)
                            || s.name.to_ascii_lowercase().contains(&query_l)
                    }) || (action == "references"
                        && (f.call_refs.iter().any(|r| r.contains(query))
                            || f.imports.iter().any(|i| i.contains(query))
                            || f.inherits_refs.iter().any(|h| h.contains(query))))
                })
                .map(|(rel_path, f)| (ppr.get(rel_path).copied().unwrap_or(0.0), rel_path, f))
                .collect();
            ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            for (score, rel_path, f) in ranked.into_iter().take(10) {
                for s in &f.symbols {
                    if s.name.eq_ignore_ascii_case(query)
                        || s.name.to_ascii_lowercase().contains(&query_l)
                    {
                        locations.push(LspLocation {
                            file: rel_path.clone(),
                            line: s.start_line as usize,
                            column: 1,
                            preview: format!("{:?} `{}` (score {:.2})", s.kind, s.name, score),
                        });
                    }
                }
                if action == "references" && locations.len() < 12 {
                    for edge in f
                        .call_refs
                        .iter()
                        .chain(f.imports.iter())
                        .chain(f.inherits_refs.iter())
                    {
                        if edge.contains(query) && locations.len() < 12 {
                            locations.push(LspLocation {
                                file: rel_path.clone(),
                                line: 1,
                                column: 1,
                                preview: format!("ref -> {edge}"),
                            });
                        }
                    }
                }
            }
        }
        LspQueryResult {
            mode: format!("ast_fallback:{action}"),
            server: "tree-sitter-workspace-graph".into(),
            summary: format!("{} AST fallback match(es)", locations.len()),
            locations,
        }
    }
}

fn line_utf16_col_to_byte(text: &str, line_0: usize, utf16_col: usize) -> usize {
    let mut byte_pos = 0usize;
    for (idx, seg) in text.split_inclusive('\n').enumerate() {
        if idx == line_0 {
            let clean = seg.trim_end_matches(['\r', '\n']);
            return byte_pos + utf16_unit_to_utf8_byte_offset(clean, utf16_col);
        }
        byte_pos += seg.len();
    }
    text.len()
}

type WorkspaceTextEdit = (u32, u32, u32, u32, String);
type WorkspaceEditsMap = BTreeMap<PathBuf, Vec<WorkspaceTextEdit>>;

fn collect_workspace_edits(
    ws_edit: &Value,
    workspace_root: &Path,
    out: &mut WorkspaceEditsMap,
) -> Result<()> {
    if let Some(changes) = ws_edit.get("changes").and_then(Value::as_object) {
        for (uri, arr_val) in changes {
            let Some(path) = file_uri_to_contained_path(uri, workspace_root) else {
                continue;
            };
            if let Some(arr) = arr_val.as_array() {
                for item in arr {
                    if let Some(te) = parse_text_edit(item) {
                        out.entry(path.clone()).or_default().push(te);
                    }
                }
            }
        }
    }
    if let Some(doc_changes) = ws_edit.get("documentChanges").and_then(Value::as_array) {
        for doc in doc_changes {
            let Some(uri) = doc
                .get("textDocument")
                .and_then(|td| td.get("uri"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            let Some(path) = file_uri_to_contained_path(uri, workspace_root) else {
                continue;
            };
            if let Some(edits) = doc.get("edits").and_then(Value::as_array) {
                for item in edits {
                    if let Some(te) = parse_text_edit(item) {
                        out.entry(path.clone()).or_default().push(te);
                    }
                }
            }
        }
    }
    Ok(())
}

fn parse_text_edit(item: &Value) -> Option<(u32, u32, u32, u32, String)> {
    let r = item.get("range")?;
    let s = r.get("start")?;
    let e = r.get("end")?;
    let sl = s.get("line")?.as_u64()? as u32;
    let sc = s.get("character")?.as_u64()? as u32;
    let el = e.get("line")?.as_u64()? as u32;
    let ec = e.get("character")?.as_u64()? as u32;
    let new_text = item.get("newText")?.as_str()?.to_owned();
    Some((sl, sc, el, ec, new_text))
}

fn parse_lsp_diagnostics(val: Option<&Value>) -> Vec<LspDiagnosticItem> {
    let Some(arr) = val.and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|d| {
            let msg = d.get("message").and_then(Value::as_str)?.to_owned();
            let sev = match d.get("severity").and_then(Value::as_u64).unwrap_or(1) {
                1 => "error",
                2 => "warning",
                3 => "info",
                _ => "hint",
            }
            .to_owned();
            let start = d.get("range").and_then(|r| r.get("start"));
            let line = start
                .and_then(|s| s.get("line"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize
                + 1;
            let column = start
                .and_then(|s| s.get("character"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize
                + 1;
            let source = d.get("source").and_then(Value::as_str).map(str::to_owned);
            Some(LspDiagnosticItem {
                severity: sev,
                line,
                column,
                message: msg,
                source,
            })
        })
        .collect()
}

fn extract_hover_text(val: &Value) -> String {
    let Some(contents) = val.get("contents") else {
        return "No hover documentation".into();
    };
    if let Some(s) = contents.as_str() {
        return s.to_owned();
    }
    if let Some(s) = contents.get("value").and_then(Value::as_str) {
        return s.to_owned();
    }
    contents.to_string()
}

fn parse_lsp_locations(val: &Value, root: &Path) -> Vec<LspLocation> {
    let mut out = Vec::new();
    let arr: Vec<&Value> = if let Some(a) = val.as_array() {
        a.iter().collect()
    } else if val.is_object() {
        vec![val]
    } else {
        Vec::new()
    };
    for item in arr {
        let uri = item
            .get("uri")
            .or_else(|| item.get("targetUri"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let range = item
            .get("range")
            .or_else(|| item.get("targetSelectionRange"))
            .or_else(|| item.get("location").and_then(|l| l.get("range")));
        if uri.is_empty() {
            if let Some(name) = item.get("name").and_then(Value::as_str) {
                let sl = item
                    .get("range")
                    .and_then(|r| r.get("start"))
                    .and_then(|s| s.get("line"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize
                    + 1;
                out.push(LspLocation {
                    file: String::new(),
                    line: sl,
                    column: 1,
                    preview: name.to_owned(),
                });
            }
            continue;
        }
        let start = range.and_then(|r| r.get("start"));
        let line0 = start
            .and_then(|s| s.get("line"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32;
        let col0_u16 = start
            .and_then(|s| s.get("character"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32;

        let resolved = file_uri_to_contained_path(uri, root);
        let (rel, line1, col1) = if let Some(abs) = resolved {
            let rel_s = abs
                .strip_prefix(root)
                .unwrap_or(&abs)
                .to_string_lossy()
                .replace('\\', "/");
            let col_utf8 = std::fs::read_to_string(&abs)
                .map(|src| lsp_utf16_to_utf8_line_col(&src, line0, col0_u16).1)
                .unwrap_or(col0_u16 as usize);
            (rel_s, line0 as usize + 1, col_utf8 + 1)
        } else {
            (uri.to_owned(), line0 as usize + 1, col0_u16 as usize + 1)
        };

        out.push(LspLocation {
            file: rel,
            line: line1,
            column: col1,
            preview: String::new(),
        });
    }
    let _ = utf8_byte_offset_to_utf16_unit("", 0);
    out
}

fn write_lsp_message(stdin: &Arc<Mutex<ChildStdin>>, payload: &Value) -> Result<()> {
    let body = serde_json::to_vec(payload)?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut w = stdin
        .lock()
        .map_err(|_| anyhow::anyhow!("LSP stdin lock poisoned"))?;
    w.write_all(header.as_bytes())?;
    w.write_all(&body)?;
    w.flush()?;
    Ok(())
}

fn read_lsp_message<R: Read>(reader: &mut BufReader<R>) -> Result<Option<Value>> {
    let mut len: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            if len.is_some() {
                break;
            }
            continue;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            if k.trim().eq_ignore_ascii_case("Content-Length") {
                len = v.trim().parse::<usize>().ok();
            }
        }
    }
    let l = len.context("LSP missing Content-Length")?;
    let mut buf = vec![0u8; l.min(16 * 1024 * 1024)];
    reader.read_exact(&mut buf)?;
    Ok(serde_json::from_slice(&buf).ok())
}

fn path_to_file_uri(path: &Path) -> String {
    let norm = path.to_string_lossy().replace('\\', "/");
    if norm.starts_with('/') {
        format!("file://{norm}")
    } else {
        format!("file:///{norm}")
    }
}

fn normalize_uri_key(uri: &str) -> String {
    uri.trim().replace('\\', "/").to_ascii_lowercase()
}

fn file_uri_to_contained_path(uri: &str, root: &Path) -> Option<PathBuf> {
    let raw = uri.strip_prefix("file:///").or_else(|| uri.strip_prefix("file://"))?;
    let decoded = raw.replace("%20", " ").replace("%3A", ":").replace("%3a", ":");
    let cand = PathBuf::from(&decoded);
    if cand.starts_with(root) {
        return Some(cand);
    }
    let root_norm = root.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
    let cand_norm = decoded.replace('\\', "/").to_ascii_lowercase();
    if let Some(rel) = cand_norm.strip_prefix(&root_norm) {
        let rel_trim = rel.trim_start_matches('/');
        return ensure_within_workspace(root, rel_trim).ok();
    }
    None
}

fn sweep_idle_clients(
    clients: &Mutex<HashMap<LspLanguage, Arc<LiveLspClient>>>,
    max_idle: Duration,
) -> usize {
    let stale: Vec<Arc<LiveLspClient>> = {
        let Ok(mut guard) = clients.lock() else {
            return 0;
        };
        let keys: Vec<LspLanguage> = guard
            .iter()
            .filter_map(|(&lang, c)| (c.idle_elapsed() >= max_idle).then_some(lang))
            .collect();
        keys.into_iter()
            .filter_map(|k| guard.remove(&k))
            .collect()
    };
    let count = stale.len();
    for client in stale {
        client.shutdown();
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsp_utf16_offset_mapping_handles_multibyte_and_surrogates() {
        let src = "let s = \"👋\"; let x = 1;\n";
        // UTF-8 byte offset of `x` vs UTF-16 code unit offset of `x`
        let byte_idx = src.find("let x").expect("find");
        let u16_pos = utf8_line_col_to_lsp_utf16(src, 0, byte_idx);
        let back = line_utf16_col_to_byte(src, 0, u16_pos.1 as usize);
        assert_eq!(back, byte_idx);
    }

    #[test]
    fn lsp_manager_starts_with_zero_processes_and_falls_back_to_ast() {
        let mgr = LazyLspManager::new(std::env::temp_dir());
        assert_eq!(mgr.clients.lock().expect("lock").len(), 0);
        assert_eq!(mgr.sweep_idle(Duration::ZERO), 0);
        let tmp = std::env::temp_dir().join(format!("omnia_lsp_diags_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let broken = tmp.join("bad.py");
        std::fs::write(&broken, "def broken(:\n    pass\n").expect("write");
        let diags = mgr.diagnostics_for_file(&broken, 100);
        assert!(!diags.is_empty(), "expected immediate tree-sitter diagnostic");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn server_request_responder_handles_configuration_and_refresh_calls() {
        let cfg = build_server_request_reply(
            &json!(7),
            "workspace/configuration",
            Some(&json!({ "items": [{ "section": "rust-analyzer" }, { "section": "files" }] })),
            "file:///workspace",
        );
        assert_eq!(cfg["id"], 7);
        assert_eq!(cfg["result"], json!([null, null]));

        let reg = build_server_request_reply(
            &json!("srv-1"),
            "client/registerCapability",
            None,
            "file:///workspace",
        );
        assert_eq!(reg["id"], "srv-1");
        assert_eq!(reg["result"], Value::Null);

        let unknown = build_server_request_reply(
            &json!(9),
            "custom/unsupported",
            None,
            "file:///workspace",
        );
        assert_eq!(unknown["error"]["code"], -32601);

        assert!(is_retryable_busy_error(&json!({ "code": -32801 })));
        assert!(is_retryable_busy_error(&json!({ "code": -32802 })));
        assert!(!is_retryable_busy_error(&json!({ "code": -32601 })));

        let cancel = build_cancel_notification(42);
        assert_eq!(cancel["method"], "$/cancelRequest");
        assert_eq!(cancel["params"]["id"], 42);
    }

    #[test]
    fn diagnostic_burst_settle_waits_for_final_generation() {
        let signal = Arc::new((Mutex::new(DiagStore::default()), Condvar::new()));
        let uri_key = "file:///workspace/src/main.rs".to_owned();
        let writer = Arc::clone(&signal);
        let key_w = uri_key.clone();

        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(25));
            {
                let (lock, cvar) = &*writer;
                let mut st = lock.lock().unwrap();
                st.publish(
                    key_w.clone(),
                    vec![LspDiagnosticItem {
                        severity: "warning".into(),
                        line: 1,
                        column: 1,
                        message: "transient burst 1".into(),
                        source: Some("test-lsp".into()),
                    }],
                );
                cvar.notify_all();
            }
            std::thread::sleep(Duration::from_millis(30));
            {
                let (lock, cvar) = &*writer;
                let mut st = lock.lock().unwrap();
                st.publish(
                    key_w,
                    vec![LspDiagnosticItem {
                        severity: "error".into(),
                        line: 5,
                        column: 3,
                        message: "settled final diagnostic".into(),
                        source: Some("test-lsp".into()),
                    }],
                );
                cvar.notify_all();
            }
        });

        let settled = wait_diagnostics_settled(
            &signal,
            &uri_key,
            0,
            Duration::from_millis(800),
            Duration::from_millis(90),
        );
        assert_eq!(settled.len(), 1);
        assert_eq!(settled[0].message, "settled final diagnostic");
    }
}
