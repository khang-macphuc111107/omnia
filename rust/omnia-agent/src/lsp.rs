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
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

struct LiveLspClient {
    server_name: String,
    lang: LspLanguage,
    _workspace_root: PathBuf,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<i64, std::sync::mpsc::Sender<Value>>>>,
    diagnostics: Arc<Mutex<HashMap<String, Vec<LspDiagnosticItem>>>>,
    doc_versions: Mutex<HashMap<String, i32>>,
    next_id: AtomicI64,
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
        let stdin = child.stdin.take().context("LSP missing stdin")?;
        let stdout = child.stdout.take().context("LSP missing stdout")?;

        let pending: Arc<Mutex<HashMap<i64, std::sync::mpsc::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let diagnostics: Arc<Mutex<HashMap<String, Vec<LspDiagnosticItem>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let pending_reader = Arc::clone(&pending);
        let diags_reader = Arc::clone(&diagnostics);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some(msg)) = read_lsp_message(&mut reader) {
                if let Some(id) = msg.get("id").and_then(Value::as_i64) {
                    if let Ok(mut map) = pending_reader.lock() {
                        if let Some(tx) = map.remove(&id) {
                            let _ = tx.send(msg);
                        }
                    }
                } else if msg.get("method").and_then(Value::as_str)
                    == Some("textDocument/publishDiagnostics")
                {
                    if let Some(params) = msg.get("params") {
                        let uri = params.get("uri").and_then(Value::as_str).unwrap_or("");
                        if !uri.is_empty() {
                            let key = normalize_uri_key(uri);
                            let items = parse_lsp_diagnostics(params.get("diagnostics"));
                            if let Ok(mut g) = diags_reader.lock() {
                                g.insert(key, items);
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
            stdin: Arc::new(Mutex::new(stdin)),
            pending,
            diagnostics,
            doc_versions: Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            _child: Mutex::new(child),
            supervisor,
        });

        let root_uri = path_to_file_uri(workspace_root);
        let _ = client.request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "rootUri": root_uri,
                "capabilities": {
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
            Duration::from_secs(5),
        )?;
        client.notify("initialized", json!({}))?;
        Ok(client)
    }

    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
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
        write_lsp_message(&self.stdin, &body)?;
        let resp = rx
            .recv_timeout(timeout)
            .with_context(|| format!("LSP `{method}` timed out after {:?}", timeout))?;
        if let Some(err) = resp.get("error") {
            bail!("LSP `{method}` error: {err}");
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    fn notify(&self, method: &str, params: Value) -> Result<()> {
        let body = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        write_lsp_message(&self.stdin, &body)
    }

    fn sync_document(&self, path: &Path, text: &str) -> Result<String> {
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
        let uri = self.sync_document(path, text)?;
        // Try LSP 3.17 pull diagnostic first cleanly.
        if let Ok(pull) = self.request(
            "textDocument/diagnostic",
            json!({ "textDocument": { "uri": uri } }),
            Duration::from_millis(wait_ms.clamp(200, 2_500)),
        ) {
            if let Some(items) = pull.get("items").and_then(Value::as_array) {
                return Ok(parse_lsp_diagnostics(Some(&Value::Array(items.clone()))));
            }
        }
        // Fallback: wait briefly for `textDocument/publishDiagnostics` push.
        let key = normalize_uri_key(&uri);
        let deadline = Instant::now() + Duration::from_millis(wait_ms.clamp(150, 2_000));
        while Instant::now() < deadline {
            if let Ok(guard) = self.diagnostics.lock() {
                if let Some(items) = guard.get(&key) {
                    return Ok(items.clone());
                }
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        Ok(Vec::new())
    }
}

/// Manager lazily starting language servers on demand, keeping cold startup at `0 ms`.
#[derive(Clone)]
pub struct LazyLspManager {
    workspace_root: PathBuf,
    clients: Arc<Mutex<HashMap<LspLanguage, Arc<LiveLspClient>>>>,
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
    /// Construct manager with zero spawned processes (`0 ms` startup).
    #[must_use]
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            workspace_root,
            clients: Arc::new(Mutex::new(HashMap::new())),
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

    fn get_or_spawn(&self, lang: LspLanguage) -> Option<Arc<LiveLspClient>> {
        if let Ok(guard) = self.clients.lock() {
            if let Some(existing) = guard.get(&lang) {
                return Some(Arc::clone(existing));
            }
        }
        let (exe, args) = Self::detect_binary(lang)?;
        let client = LiveLspClient::spawn(lang, exe, args, &self.workspace_root).ok()?;
        if let Ok(mut guard) = self.clients.lock() {
            guard.insert(lang, Arc::clone(&client));
        }
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
                            if let Ok(raw) = client.request(method, params, Duration::from_secs(3))
                            {
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
            Duration::from_secs(5),
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
        let tmp = std::env::temp_dir().join(format!("omnia_lsp_diags_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let broken = tmp.join("bad.py");
        std::fs::write(&broken, "def broken(:\n    pass\n").expect("write");
        let diags = mgr.diagnostics_for_file(&broken, 100);
        assert!(!diags.is_empty(), "expected immediate tree-sitter diagnostic");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
