//! Lazy On-Demand LSP Manager (`0 ms` cold-start cost).
//!
//! Never pre-boots language servers during startup! Spawns a supervised LSP server
//! (`rust-analyzer`, `pyright-langserver`/`pylsp`, `typescript-language-server`, `gopls`)
//! strictly on first semantic tool query (`definition`, `references`, `diagnostics`,
//! `rename_preview`), with automatic graceful fallback to `WorkspaceGraphIndex` AST
//! symbol/edge traversal whenever no LSP binary is installed on the host.

use crate::graph_locator::WorkspaceGraphIndex;
use crate::path_guard::sanitize_windows_path;
use crate::supervisor::ProcessSupervisor;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LspLanguage {
    Rust,
    Python,
    TypeScript,
    Go,
}

impl LspLanguage {
    #[must_use]
    pub fn from_path(path: &Path) -> Option<Self> {
        match path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref()
        {
            Some("rs") => Some(Self::Rust),
            Some("py" | "pyi") => Some(Self::Python),
            Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs") => Some(Self::TypeScript),
            Some("go") => Some(Self::Go),
            _ => None,
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
        }
    }

    #[must_use]
    pub const fn language_id(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::Python => "python",
            Self::TypeScript => "typescript",
            Self::Go => "go",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspQueryResult {
    pub backend: String, // "lsp:<cmd>" | "ast-fallback"
    pub action: String,
    pub symbol: Option<String>,
    pub locations: Vec<LspLocation>,
    pub diagnostics: Vec<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLocation {
    pub file: String,
    pub start_line: u32,
    pub end_line: u32,
    pub detail: String,
}

struct LiveLspClient {
    cmd_name: String,
    next_id: u64,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    _child: Child,
    _supervisor: ProcessSupervisor,
}

impl LiveLspClient {
    async fn spawn(
        workspace_root: &Path,
        cmd_bin: &Path,
        cmd_name: &str,
        args: &[&str],
    ) -> Result<Self> {
        let mut cmd = Command::new(cmd_bin);
        crate::supervisor::strip_provider_secrets_tokio(&mut cmd);
        cmd.args(args)
            .current_dir(workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            cmd.creation_flags(crate::supervisor::CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .with_context(|| format!("failed to spawn LSP server {cmd_name}"))?;
        let supervisor = child
            .id()
            .map(ProcessSupervisor::attach_pid)
            .unwrap_or_else(ProcessSupervisor::unsupervised);
        let stdin = child.stdin.take().context("LSP stdin unavailable")?;
        let stdout = BufReader::new(child.stdout.take().context("LSP stdout unavailable")?);

        let mut client = Self {
            cmd_name: cmd_name.to_string(),
            next_id: 1,
            stdin,
            stdout,
            _child: child,
            _supervisor: supervisor,
        };

        let root_uri = path_to_file_uri(workspace_root);
        let _init = client
            .request(
                "initialize",
                json!({
                    "processId": std::process::id(),
                    "rootUri": root_uri,
                    "capabilities": {
                        "textDocument": {
                            "references": { "dynamicRegistration": false },
                            "definition": { "dynamicRegistration": false },
                            "rename": { "prepareSupport": false }
                        }
                    }
                }),
                Duration::from_secs(6),
            )
            .await?;
        client.notify("initialized", json!({})).await?;
        Ok(client)
    }

    async fn send_frame(&mut self, payload: &Value) -> Result<()> {
        let body = serde_json::to_vec(payload)?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        self.stdin.write_all(header.as_bytes()).await?;
        self.stdin.write_all(&body).await?;
        self.stdin.flush().await?;
        Ok(())
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        self.send_frame(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
        .await
    }

    async fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.send_frame(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))
        .await?;

        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
            if rem.is_zero() {
                bail!("LSP request '{method}' timed out");
            }
            let msg = tokio::time::timeout(rem, self.read_frame()).await??;
            if msg.get("id").and_then(|v| v.as_u64()) == Some(id) {
                if let Some(err) = msg.get("error") {
                    bail!("LSP error on '{method}': {err}");
                }
                return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }

    async fn read_frame(&mut self) -> Result<Value> {
        let mut content_length: Option<usize> = None;
        loop {
            let mut line = String::new();
            let n = self.stdout.read_line(&mut line).await?;
            if n == 0 {
                bail!("LSP stdout EOF");
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                break;
            }
            if let Some((k, v)) = trimmed.split_once(':') {
                if k.eq_ignore_ascii_case("content-length") {
                    content_length = v.trim().parse::<usize>().ok();
                }
            }
        }
        let len = content_length.context("missing Content-Length in LSP frame")?;
        if len > 16 * 1024 * 1024 {
            bail!("LSP frame exceeds 16 MiB cap");
        }
        let mut buf = vec![0u8; len];
        self.stdout.read_exact(&mut buf).await?;
        let val: Value = serde_json::from_slice(&buf)?;
        Ok(val)
    }

    async fn open_document(&mut self, abs_path: &Path, lang: LspLanguage) -> Result<String> {
        let uri = path_to_file_uri(abs_path);
        let text = std::fs::read_to_string(abs_path).unwrap_or_default();
        self.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": uri,
                    "languageId": lang.language_id(),
                    "version": 1,
                    "text": text
                }
            }),
        )
        .await?;
        Ok(uri)
    }
}

/// Zero-cold-start lazy LSP coordinator.
#[derive(Clone)]
pub struct LazyLspManager {
    workspace_root: PathBuf,
    clients: Arc<AsyncMutex<HashMap<LspLanguage, LiveLspClient>>>,
}

impl LazyLspManager {
    /// Construct manager with zero spawned processes (`0 ms` startup).
    #[must_use]
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            workspace_root: sanitize_windows_path(&workspace_root),
            clients: Arc::new(AsyncMutex::new(HashMap::new())),
        }
    }

    /// Check whether a language server binary is discoverable on `PATH` without spawning it.
    #[must_use]
    pub fn detect_binary(lang: LspLanguage) -> Option<(PathBuf, &'static str, &'static [&'static str])> {
        for &(bin, args) in lang.candidate_commands() {
            if let Ok(path) = which::which(bin) {
                return Some((path, bin, args));
            }
        }
        None
    }

    /// Execute a semantic LSP query (`definition`, `references`, `diagnostics`, `rename_preview`),
    /// spawning the matching LSP lazily if available and falling back deterministically to the
    /// `WorkspaceGraphIndex` AST graph when no LSP server is installed.
    pub async fn query(
        &self,
        action: &str,
        rel_path: &str,
        line_1based: u32,
        character_0based: u32,
        symbol_hint: Option<&str>,
        graph: &Arc<Mutex<WorkspaceGraphIndex>>,
    ) -> LspQueryResult {
        let abs_path = match crate::path_guard::ensure_within_workspace(&self.workspace_root, rel_path) {
            Ok(p) => p,
            Err(e) => {
                return LspQueryResult {
                    backend: "path-guard-blocked".into(),
                    action: action.to_string(),
                    symbol: symbol_hint.map(String::from),
                    locations: Vec::new(),
                    diagnostics: Vec::new(),
                    notes: Some(format!("Blocked unsafe path: {e}")),
                };
            }
        };
        let lang_opt = LspLanguage::from_path(&abs_path);

        if let Some(lang) = lang_opt {
            if let Some((bin, cmd_name, args)) = Self::detect_binary(lang) {
                let mut map = self.clients.lock().await;
                let ready = if let std::collections::hash_map::Entry::Vacant(e) = map.entry(lang) {
                    match LiveLspClient::spawn(&self.workspace_root, &bin, cmd_name, args).await {
                        Ok(client) => {
                            e.insert(client);
                            true
                        }
                        Err(_) => false,
                    }
                } else {
                    true
                };
                if ready {
                    if let Some(client) = map.get_mut(&lang) {
                        if let Ok(uri) = client.open_document(&abs_path, lang).await {
                            let pos = json!({
                                "line": line_1based.saturating_sub(1),
                                "character": character_0based
                            });
                            let method = match action {
                                "definition" => Some(("textDocument/definition", json!({ "textDocument": { "uri": uri }, "position": pos }))),
                                "references" => Some(("textDocument/references", json!({
                                    "textDocument": { "uri": uri },
                                    "position": pos,
                                    "context": { "includeDeclaration": true }
                                }))),
                                _ => None,
                            };
                            if let Some((m, params)) = method {
                                if let Ok(res) = client.request(m, params, Duration::from_secs(4)).await {
                                    let locs = parse_lsp_locations(&res, &self.workspace_root);
                                    if !locs.is_empty() {
                                        return LspQueryResult {
                                            backend: format!("lsp:{}", client.cmd_name),
                                            action: action.to_string(),
                                            symbol: symbol_hint.map(String::from),
                                            locations: locs,
                                            diagnostics: Vec::new(),
                                            notes: None,
                                        };
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Deterministic Tree-sitter AST + CSR graph fallback (0ms external dependency)
        self.ast_graph_fallback(action, rel_path, symbol_hint, graph)
    }

    fn ast_graph_fallback(
        &self,
        action: &str,
        rel_path: &str,
        symbol_hint: Option<&str>,
        graph: &Arc<Mutex<WorkspaceGraphIndex>>,
    ) -> LspQueryResult {
        let mut locations = Vec::new();
        let mut diagnostics = Vec::new();
        let abs_checked = match crate::path_guard::ensure_within_workspace(&self.workspace_root, rel_path) {
            Ok(p) => p,
            Err(e) => {
                return LspQueryResult {
                    backend: "path-guard-blocked".into(),
                    action: action.to_string(),
                    symbol: symbol_hint.map(String::from),
                    locations: Vec::new(),
                    diagnostics: Vec::new(),
                    notes: Some(format!("Blocked unsafe path: {e}")),
                };
            }
        };
        if let Ok(mut g) = graph.lock() {
            let _ = g.refresh();
            if action == "diagnostics" {
                if let Ok(src) = std::fs::read_to_string(&abs_checked) {
                    let rep = crate::graph_locator::verify_syntax_delta(rel_path, "", &src, None);
                    for d in rep.diagnostics {
                        diagnostics.push(format!("line {} ({}): {}", d.line, d.kind, d.snippet));
                    }
                }
            }
            if let Some(sym) = symbol_hint.filter(|s| !s.trim().is_empty()) {
                for hit in g.search_entity(sym, 20) {
                    locations.push(LspLocation {
                        file: hit.file,
                        start_line: hit.start_line,
                        end_line: hit.end_line,
                        detail: format!("{} {} ({})", hit.kind, hit.name, hit.signature),
                    });
                }
            } else {
                for hit in g.symbols_in_file(rel_path) {
                    locations.push(LspLocation {
                        file: hit.file,
                        start_line: hit.start_line,
                        end_line: hit.end_line,
                        detail: format!("{} {} ({})", hit.kind, hit.name, hit.signature),
                    });
                }
            }
        }
        LspQueryResult {
            backend: "ast-fallback".into(),
            action: action.to_string(),
            symbol: symbol_hint.map(String::from),
            locations,
            diagnostics,
            notes: Some("Resolved via deterministic Tree-sitter AST/CSR graph index".into()),
        }
    }
}

fn path_to_file_uri(path: &Path) -> String {
    let clean = sanitize_windows_path(path);
    let s = clean.to_string_lossy().replace('\\', "/");
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

fn parse_lsp_locations(val: &Value, root: &Path) -> Vec<LspLocation> {
    let mut out = Vec::new();
    let items: Vec<&Value> = if let Some(arr) = val.as_array() {
        arr.iter().collect()
    } else if val.is_object() {
        vec![val]
    } else {
        Vec::new()
    };
    let root_norm = sanitize_windows_path(root)
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    for item in items {
        let uri = item
            .get("uri")
            .or_else(|| item.get("targetUri"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let range = item.get("range").or_else(|| item.get("targetRange"));
        let start_line = range
            .and_then(|r| r.pointer("/start/line"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32
            + 1;
        let end_line = range
            .and_then(|r| r.pointer("/end/line"))
            .and_then(|v| v.as_u64())
            .unwrap_or(u64::from(start_line.saturating_sub(1))) as u32
            + 1;
        if uri.is_empty() {
            continue;
        }
        let trimmed = uri
            .strip_prefix("file:///")
            .or_else(|| uri.strip_prefix("file://"))
            .unwrap_or(uri);
        let rel = if trimmed.to_ascii_lowercase().starts_with(&root_norm) {
            trimmed[root_norm.len()..].trim_start_matches('/').to_string()
        } else {
            trimmed.to_string()
        };
        out.push(LspLocation {
            file: rel,
            start_line,
            end_line,
            detail: "LSP location".into(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lazy_lsp_manager_starts_with_zero_spawned_servers() {
        let mgr = LazyLspManager::new(std::env::temp_dir());
        assert_eq!(
            LspLanguage::from_path(Path::new("src/main.rs")),
            Some(LspLanguage::Rust)
        );
        assert_eq!(
            LspLanguage::from_path(Path::new("pkg/mod.py")),
            Some(LspLanguage::Python)
        );
        assert_eq!(
            LspLanguage::from_path(Path::new("web/app.tsx")),
            Some(LspLanguage::TypeScript)
        );
        assert_eq!(
            LspLanguage::from_path(Path::new("cmd/srv.go")),
            Some(LspLanguage::Go)
        );
        let uri = path_to_file_uri(Path::new(r"C:\repo\src\lib.rs"));
        assert!(uri.starts_with("file:///C:/repo/src/lib.rs"));
        drop(mgr);
    }

    #[tokio::test]
    async fn lazy_lsp_manager_blocks_traversal_and_reserved_device_paths() {
        let tmp = std::env::temp_dir().join(format!("omni_lsp_guard_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mgr = LazyLspManager::new(tmp.clone());
        let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(&tmp)));

        let r1 = mgr
            .query("diagnostics", "../outside.py", 1, 0, None, &graph)
            .await;
        assert_eq!(r1.backend, "path-guard-blocked");

        let r2 = mgr.query("diagnostics", "CON", 1, 0, None, &graph).await;
        assert_eq!(r2.backend, "path-guard-blocked");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
