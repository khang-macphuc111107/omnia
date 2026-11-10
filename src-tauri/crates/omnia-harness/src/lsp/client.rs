//! One language-server process spoken to over stdio.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;

use super::framing::{encode, Decoder};
use super::text::{path_key, path_to_uri, uri_key};

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub const FIRST_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const INIT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LspError {
    Cancelled,
    Msg(String),
}

impl From<String> for LspError {
    fn from(value: String) -> Self {
        Self::Msg(value)
    }
}

impl From<&str> for LspError {
    fn from(value: &str) -> Self {
        Self::Msg(value.to_string())
    }
}

#[derive(Debug)]
struct RpcError {
    code: i64,
    message: String,
}

#[derive(Debug, Clone)]
pub struct Launch {
    pub name: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub initialization_options: Option<Value>,
}

#[derive(Default)]
struct DiagState {
    generation: u64,
    items: Vec<Value>,
}

struct Shared {
    writer: AsyncMutex<ChildStdin>,
    pending: Mutex<HashMap<i64, oneshot::Sender<Result<Value, RpcError>>>>,
    diags: Mutex<HashMap<String, DiagState>>,
    alive: AtomicBool,
    next_id: AtomicI64,
    stderr_tail: Mutex<String>,
}

impl Shared {
    async fn send(&self, msg: &Value) -> Result<(), String> {
        let bytes = encode(msg);
        let mut writer = self.writer.lock().await;
        writer
            .write_all(&bytes)
            .await
            .map_err(|e| format!("language server write failed: {e}"))?;
        writer
            .flush()
            .await
            .map_err(|e| format!("language server write failed: {e}"))
    }

    fn fail_pending(&self, message: &str) {
        let pending: Vec<_> = self.pending.lock().unwrap().drain().collect();
        for (_, tx) in pending {
            let _ = tx.send(Err(RpcError {
                code: -1,
                message: message.to_string(),
            }));
        }
    }

    async fn dispatch(&self, msg: Value) {
        let id = msg.get("id").filter(|id| !id.is_null()).cloned();
        let method = msg.get("method").and_then(Value::as_str).map(String::from);
        match (method, id) {
            (Some(method), Some(id)) => {
                // Server -> client request.
                let result = match method.as_str() {
                    "workspace/configuration" => {
                        let n = msg
                            .pointer("/params/items")
                            .and_then(Value::as_array)
                            .map_or(0, Vec::len);
                        json!({"jsonrpc":"2.0","id":id,"result":vec![Value::Null; n]})
                    }
                    "client/registerCapability"
                    | "client/unregisterCapability"
                    | "window/workDoneProgress/create"
                    | "workspace/diagnostic/refresh"
                    | "workspace/inlayHint/refresh"
                    | "workspace/semanticTokens/refresh"
                    | "workspace/codeLens/refresh" => {
                        json!({"jsonrpc":"2.0","id":id,"result":null})
                    }
                    "workspace/workspaceFolders" => json!({"jsonrpc":"2.0","id":id,"result":null}),
                    _ => json!({"jsonrpc":"2.0","id":id,
                        "error":{"code":-32601,"message":format!("method `{method}` not supported")}}),
                };
                let _ = self.send(&result).await;
            }
            (Some(method), None) => {
                if method == "textDocument/publishDiagnostics" {
                    if let Some(params) = msg.get("params") {
                        let uri = params.get("uri").and_then(Value::as_str).unwrap_or("");
                        let items = params
                            .get("diagnostics")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let mut diags = self.diags.lock().unwrap();
                        let entry = diags.entry(uri_key(uri)).or_default();
                        entry.generation += 1;
                        entry.items = items;
                    }
                }
            }
            (None, Some(id)) => {
                let Some(id) = id.as_i64() else { return };
                let Some(tx) = self.pending.lock().unwrap().remove(&id) else {
                    return;
                };
                let outcome = match msg.get("error") {
                    Some(error) => Err(RpcError {
                        code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
                        message: error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown error")
                            .to_string(),
                    }),
                    None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(outcome);
            }
            (None, None) => {}
        }
    }
}

async fn read_loop(shared: Arc<Shared>, mut stdout: ChildStdout) {
    let mut decoder = Decoder::default();
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = match stdout.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        decoder.push(&buf[..n]);
        loop {
            match decoder.next_message() {
                Ok(Some(msg)) => shared.dispatch(msg).await,
                Ok(None) => break,
                Err(_) => continue,
            }
        }
    }
    shared.alive.store(false, Ordering::SeqCst);
    shared.fail_pending("the language server exited");
}

struct DocState {
    version: i64,
    text: String,
}

pub struct Doc {
    pub uri: String,
    pub key: String,
    /// Text as sent to the server (BOM stripped).
    pub text: String,
    /// True when the server just learned about this content (open or change).
    pub fresh: bool,
}

pub struct LspClient {
    pub name: String,
    pub root: PathBuf,
    shared: Arc<Shared>,
    child: Mutex<Option<Child>>,
    pid: Option<u32>,
    last_used: Mutex<Instant>,
    served_request: AtomicBool,
    fresh_server: AtomicBool,
    docs: AsyncMutex<HashMap<String, DocState>>,
}

impl LspClient {
    /// Spawns the server, performs the `initialize` handshake.
    pub async fn start(
        launch: &Launch,
        root: &Path,
        cancel: &CancellationToken,
    ) -> Result<Arc<Self>, LspError> {
        let mut cmd = tokio::process::Command::new(&launch.program);
        cmd.args(&launch.args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn().map_err(|e| {
            LspError::Msg(format!(
                "failed to start `{}`: {e}",
                launch.program.display()
            ))
        })?;
        let pid = child.id();
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let mut stderr = child.stderr.take().expect("piped stderr");
        let shared = Arc::new(Shared {
            writer: AsyncMutex::new(stdin),
            pending: Mutex::default(),
            diags: Mutex::default(),
            alive: AtomicBool::new(true),
            next_id: AtomicI64::new(1),
            stderr_tail: Mutex::default(),
        });
        tokio::spawn(read_loop(Arc::clone(&shared), stdout));
        let sink = Arc::clone(&shared);
        tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut tail = sink.stderr_tail.lock().unwrap();
                tail.push_str(&String::from_utf8_lossy(&buf[..n]));
                if tail.len() > 4000 {
                    let mut cut = tail.len() - 4000;
                    while !tail.is_char_boundary(cut) {
                        cut += 1;
                    }
                    tail.drain(..cut);
                }
            }
        });
        let client = Arc::new(Self {
            name: launch.name.clone(),
            root: root.to_path_buf(),
            shared,
            child: Mutex::new(Some(child)),
            pid,
            last_used: Mutex::new(Instant::now()),
            served_request: AtomicBool::new(false),
            fresh_server: AtomicBool::new(true),
            docs: AsyncMutex::default(),
        });

        let root_uri = path_to_uri(root);
        let folder_name = root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("workspace");
        let mut params = json!({
            "processId": std::process::id(),
            "clientInfo": {"name": "omnia", "version": "0.1"},
            "rootUri": root_uri,
            "rootPath": root.to_string_lossy(),
            "workspaceFolders": [{"uri": root_uri, "name": folder_name}],
            "capabilities": client_capabilities(),
        });
        if let Some(options) = &launch.initialization_options {
            params["initializationOptions"] = options.clone();
        }
        client
            .request_with("initialize", params, cancel, INIT_TIMEOUT, false)
            .await?;
        client.notify("initialized", json!({})).await?;
        Ok(client)
    }

    fn annotate(&self, error: LspError, what: &str) -> LspError {
        match error {
            LspError::Msg(message) => {
                let tail = self.shared.stderr_tail.lock().unwrap().trim().to_string();
                let tail = if tail.is_empty() {
                    String::new()
                } else {
                    let start = tail.len().saturating_sub(600);
                    let start = (start..tail.len())
                        .find(|i| tail.is_char_boundary(*i))
                        .unwrap_or(0);
                    format!("\nserver stderr: {}", &tail[start..])
                };
                LspError::Msg(format!("{} {what}: {message}{tail}", self.name))
            }
            other => other,
        }
    }

    pub fn is_alive(&self) -> bool {
        self.shared.alive.load(Ordering::SeqCst)
    }

    pub fn idle_for(&self) -> Duration {
        self.last_used.lock().unwrap().elapsed()
    }

    fn touch(&self) {
        *self.last_used.lock().unwrap() = Instant::now();
    }

    /// True once, for the first caller after the server started.
    pub fn take_fresh_server(&self) -> bool {
        self.fresh_server.swap(false, Ordering::SeqCst)
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), LspError> {
        self.shared
            .send(&json!({"jsonrpc":"2.0","method":method,"params":params}))
            .await
            .map_err(LspError::Msg)
    }

    /// Request with the standard timeout (60s for the very first one).
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, LspError> {
        let timeout = if self.served_request.load(Ordering::SeqCst) {
            REQUEST_TIMEOUT
        } else {
            FIRST_REQUEST_TIMEOUT
        };
        let result = self
            .request_with(method, params, cancel, timeout, true)
            .await;
        if result.is_ok() {
            self.served_request.store(true, Ordering::SeqCst);
        }
        result
    }

    async fn request_with(
        &self,
        method: &str,
        params: Value,
        cancel: &CancellationToken,
        timeout: Duration,
        retry_busy: bool,
    ) -> Result<Value, LspError> {
        self.touch();
        let deadline = tokio::time::Instant::now() + timeout;
        let mut attempts = 0;
        loop {
            attempts += 1;
            match self
                .request_once(method, params.clone(), cancel, deadline)
                .await
            {
                // ContentModified / ServerCancelled: the server is still indexing.
                Err(Attempt::Rpc(RpcError { code, .. }))
                    if retry_busy && (code == -32801 || code == -32802) && attempts < 8 =>
                {
                    tokio::select! {
                        _ = cancel.cancelled() => return Err(LspError::Cancelled),
                        _ = tokio::time::sleep(Duration::from_millis(400)) => {}
                    }
                }
                Err(Attempt::Rpc(error)) => {
                    return Err(LspError::Msg(format!(
                        "{method} failed ({}): {}",
                        error.code, error.message
                    )))
                }
                Err(Attempt::Other(error)) => return Err(error),
                Ok(value) => {
                    self.touch();
                    return Ok(value);
                }
            }
        }
    }

    async fn request_once(
        &self,
        method: &str,
        params: Value,
        cancel: &CancellationToken,
        deadline: tokio::time::Instant,
    ) -> Result<Value, Attempt> {
        if !self.is_alive() {
            return Err(Attempt::Other(self.annotate(
                LspError::Msg("the language server has exited".into()),
                method,
            )));
        }
        let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.shared.pending.lock().unwrap().insert(id, tx);
        let sent = self
            .shared
            .send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await;
        if let Err(error) = sent {
            self.shared.pending.lock().unwrap().remove(&id);
            return Err(Attempt::Other(LspError::Msg(error)));
        }
        let abandon = |why: LspError| async move {
            self.shared.pending.lock().unwrap().remove(&id);
            let _ = self.notify("$/cancelRequest", json!({"id": id})).await;
            Attempt::Other(why)
        };
        tokio::select! {
            _ = cancel.cancelled() => Err(abandon(LspError::Cancelled).await),
            _ = tokio::time::sleep_until(deadline) => Err(abandon(LspError::Msg(format!(
                "{} did not answer `{method}` in time (it may still be indexing the project; try again shortly)",
                self.name
            ))).await),
            reply = rx => match reply {
                Ok(Ok(value)) => Ok(value),
                Ok(Err(error)) if error.code == -1 => {
                    Err(Attempt::Other(self.annotate(LspError::Msg(error.message), method)))
                }
                Ok(Err(error)) => Err(Attempt::Rpc(error)),
                Err(_) => Err(Attempt::Other(LspError::Msg("language server connection closed".into()))),
            },
        }
    }

    /// Makes the server's view of `path` match the file on disk.
    pub async fn sync_document(&self, path: &Path, language_id: &str) -> Result<Doc, LspError> {
        self.touch();
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|e| LspError::Msg(format!("cannot read {}: {e}", path.display())))?;
        let text = String::from_utf8(bytes)
            .map_err(|_| LspError::Msg(format!("{} is not valid UTF-8", path.display())))?;
        let text = text
            .strip_prefix('\u{feff}')
            .map(String::from)
            .unwrap_or(text);
        let uri = path_to_uri(path);
        let key = path_key(path);
        let mut docs = self.docs.lock().await;
        let fresh = match docs.get_mut(&key) {
            Some(state) if state.text == text => false,
            Some(state) => {
                state.version += 1;
                state.text = text.clone();
                self.notify(
                    "textDocument/didChange",
                    json!({"textDocument":{"uri":uri,"version":state.version},
                           "contentChanges":[{"text":text}]}),
                )
                .await?;
                true
            }
            None => {
                docs.insert(
                    key.clone(),
                    DocState {
                        version: 1,
                        text: text.clone(),
                    },
                );
                self.notify(
                    "textDocument/didOpen",
                    json!({"textDocument":{"uri":uri,"languageId":language_id,"version":1,"text":text}}),
                )
                .await?;
                true
            }
        };
        Ok(Doc {
            uri,
            key,
            text,
            fresh,
        })
    }

    pub fn diagnostics_generation(&self, key: &str) -> u64 {
        self.shared
            .diags
            .lock()
            .unwrap()
            .get(key)
            .map_or(0, |d| d.generation)
    }

    fn diagnostics_snapshot(&self, key: &str) -> Option<(u64, Vec<Value>)> {
        self.shared
            .diags
            .lock()
            .unwrap()
            .get(key)
            .map(|d| (d.generation, d.items.clone()))
    }

    /// Waits for `publishDiagnostics` newer than `since`, then lets bursts
    /// settle. Returns `None` when the server published nothing in time.
    pub async fn wait_diagnostics(
        &self,
        key: &str,
        since: u64,
        fresh: bool,
        budget: Duration,
        cancel: &CancellationToken,
    ) -> Result<Option<Vec<Value>>, LspError> {
        let deadline = tokio::time::Instant::now() + budget;
        if !fresh {
            if let Some((generation, items)) = self.diagnostics_snapshot(key) {
                if generation > 0 {
                    return Ok(Some(items));
                }
            }
        }
        let tick = Duration::from_millis(40);
        let sleep = |d: Duration| async move {
            tokio::select! {
                _ = cancel.cancelled() => Err(LspError::Cancelled),
                _ = tokio::time::sleep(d) => Ok(()),
            }
        };
        loop {
            if self.diagnostics_generation(key) > since {
                break;
            }
            if tokio::time::Instant::now() >= deadline || !self.is_alive() {
                return Ok(None);
            }
            sleep(tick).await?;
        }
        // Settle: servers often publish syntax first, semantics later.
        let settle_until = tokio::time::Instant::now() + Duration::from_millis(1500);
        let mut last = self.diagnostics_generation(key);
        let mut quiet = Duration::ZERO;
        while quiet < Duration::from_millis(350) && tokio::time::Instant::now() < settle_until {
            sleep(tick).await?;
            let now = self.diagnostics_generation(key);
            if now != last {
                last = now;
                quiet = Duration::ZERO;
            } else {
                quiet += tick;
            }
        }
        Ok(self.diagnostics_snapshot(key).map(|(_, items)| items))
    }

    /// Polite shutdown, then kill.
    pub async fn shutdown(&self) {
        if self.is_alive() {
            let cancel = CancellationToken::new();
            let _ = self
                .request_with(
                    "shutdown",
                    Value::Null,
                    &cancel,
                    Duration::from_secs(3),
                    false,
                )
                .await;
            let _ = self.notify("exit", Value::Null).await;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        self.kill();
    }

    fn kill(&self) {
        self.shared.alive.store(false, Ordering::SeqCst);
        let Some(mut child) = self.child.lock().unwrap().take() else {
            return;
        };
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(0x0800_0000)
                .status();
        }
        #[cfg(not(windows))]
        let _ = self.pid;
        let _ = child.start_kill();
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        self.kill();
    }
}

enum Attempt {
    Rpc(RpcError),
    Other(LspError),
}

fn client_capabilities() -> Value {
    json!({
        "general": {"positionEncodings": ["utf-16"]},
        "workspace": {
            "workspaceFolders": true,
            "configuration": true,
            "applyEdit": false,
            "workspaceEdit": {"documentChanges": true, "resourceOperations": []},
            "symbol": {"dynamicRegistration": false}
        },
        "textDocument": {
            "synchronization": {"dynamicRegistration": false, "didSave": false},
            "definition": {"linkSupport": true},
            "references": {},
            "hover": {"contentFormat": ["markdown", "plaintext"]},
            "documentSymbol": {"hierarchicalDocumentSymbolSupport": true},
            "rename": {"prepareSupport": false},
            "publishDiagnostics": {"relatedInformation": false}
        },
        "window": {"workDoneProgress": true}
    })
}
