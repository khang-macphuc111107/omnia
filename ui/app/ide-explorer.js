"use strict";

(function initIdeExplorerModule(global) {
  const Studio = (global.OmniaStudio = global.OmniaStudio || {});
  const { escapeHtml, formatBytes, highlightCode } = Studio.utils;

  const RUST_CRATES = [
    {
      id: "omnia-winsqlite",
      title: "omnia-winsqlite",
      kind: "Windows SDK SQLite FFI Crate",
      paths: "rust/omnia-winsqlite/src/lib.rs",
      manifestPath: "rust/omnia-winsqlite/Cargo.toml",
      entryFile: "rust/omnia-winsqlite/src/lib.rs",
      sdkLibs: ["winsqlite3.lib (Windows 11 SDK)"],
      summary: "Thin #[link(name = \"winsqlite3\")] FFI bindings for Windows 11 native SQLite WAL handles, prepared statements, and status codes with zero external C toolchain.",
      code:
        "#[link(name = \"winsqlite3\")]\n" +
        "extern \"system\" {\n" +
        "    pub fn sqlite3_open_v2(filename: *const i8, pp_db: *mut *mut sqlite3, flags: i32, z_vfs: *const i8) -> i32;\n" +
        "    pub fn sqlite3_wal_checkpoint_v2(db: *mut sqlite3, z_db: *const i8, mode: i32, pn_log: *mut i32, pn_ckpt: *mut i32) -> i32;\n" +
        "}"
    },
    {
      id: "omnia-core",
      title: "omnia-core",
      kind: "Core Foundations Rust Crate",
      paths: "rust/omnia-core/src/lib.rs",
      manifestPath: "rust/omnia-core/Cargo.toml",
      entryFile: "rust/omnia-core/src/lib.rs",
      sdkLibs: ["bcrypt.dll (CNG SHA-256)", "serde / serde_json"],
      summary: "Zero-trust foundation: SHA-256 hex digesting, SecretRedactor pattern sanitization, UTF-8 safe slicing, and unified typed OmniaError diagnostics.",
      code:
        "pub fn sha256_hex(bytes: &[u8]) -> String { /* CNG / SHA-256 digest */ }\n" +
        "pub fn redact_secrets(text: &str) -> String { /* token & header scrubbing */ }\n" +
        "pub struct OmniaError {\n" +
        "    pub code: &'static str,\n" +
        "    pub message: String,\n" +
        "}"
    },
    {
      id: "omnia-storage",
      title: "omnia-storage",
      kind: "SQLite WAL Storage Crate",
      paths: "rust/omnia-storage/src/lib.rs",
      manifestPath: "rust/omnia-storage/Cargo.toml",
      entryFile: "rust/omnia-storage/src/lib.rs",
      sdkLibs: ["omnia-winsqlite", "omnia-core"],
      summary: "Cooperative process ownership lease (acquire_lease, heartbeat, release_lease), paged SessionStore records, and SHA-256 deduplicated attachments.",
      code:
        "pub struct LeaseStatus {\n" +
        "    pub acquired: bool,\n" +
        "    pub owner_pid: u32,\n" +
        "    pub lease_epoch: u64,\n" +
        "}\n" +
        "impl SessionStore {\n" +
        "    pub fn acquire_lease(&self, holder: &str, pid: u32) -> Result<LeaseStatus, OmniaError>;\n" +
        "}"
    },
    {
      id: "omnia-routing",
      title: "omnia-routing",
      kind: "Dynamic Provider Router Crate",
      paths: "rust/omnia-routing/src/lib.rs",
      manifestPath: "rust/omnia-routing/Cargo.toml",
      entryFile: "rust/omnia-routing/src/lib.rs",
      sdkLibs: ["omnia-core", "Tokio"],
      summary: "Deterministic DynamicProviderRouter: capability/privacy filtering, QuotaState::{Known,Unknown,Stale,Contradictory}, circuit breakers, and redacted receipts.",
      code:
        "pub enum QuotaState { Known, Unknown, Stale, Contradictory }\n" +
        "pub enum CircuitState { Closed, Open, HalfOpen }\n" +
        "pub struct RouteDecisionReceipt {\n" +
        "    pub receipt_id: String,\n" +
        "    pub policy_hash: String,\n" +
        "    pub selected_route: Option<String>,\n" +
        "}"
    },
    {
      id: "omnia-graph",
      title: "omnia-graph",
      kind: "PeerMesh & Graphify Crate",
      paths: "rust/omnia-graph/src/lib.rs",
      manifestPath: "rust/omnia-graph/Cargo.toml",
      entryFile: "rust/omnia-graph/src/lib.rs",
      sdkLibs: ["omnia-core"],
      summary: "Symmetric 2-way PeerMeshGraph (A <-> B duplex arcs, disjoint_paths guard, max_hops fencing) + GraphifyIndex (EXTRACTED, INFERRED, quarantined AMBIGUOUS).",
      code:
        "pub enum EdgeProvenance { Extracted, Inferred, Ambiguous }\n" +
        "pub enum TraverseDirection { Forward, Reverse, Both }\n" +
        "impl PeerMeshGraph {\n" +
        "    pub fn add_duplex_link(&mut self, peer_a: &str, peer_b: &str) -> bool;\n" +
        "    pub fn send_peer(&mut self, from: &str, to: &str, body: &str) -> u64;\n" +
        "}"
    },
    {
      id: "omnia-harness",
      title: "omnia-harness",
      kind: "Memory, RAG, Steer & Composer Crate",
      paths: "rust/omnia-harness/src/lib.rs",
      manifestPath: "rust/omnia-harness/Cargo.toml",
      entryFile: "rust/omnia-harness/src/lib.rs",
      sdkLibs: ["omnia-core", "omnia-graph"],
      summary: "Hierarchical MemoryGraph with plaintext-free SHA-256 ErasureReceipt, bilingual EN/VN ProactiveRag detector, SkillRegistry, ComposerModel, and SteerQueue.",
      code:
        "pub struct ErasureReceipt {\n" +
        "    pub receipt_id: String,\n" +
        "    pub previous_digest_sha256: String,\n" +
        "    pub verified_plaintext_free: bool,\n" +
        "}\n" +
        "pub struct SteerState {\n" +
        "    pub token_budget: Option<u64>, // None (Unlimited) unless explicitly set\n" +
        "}"
    },
    {
      id: "omnia-connector-gateway",
      title: "omnia-connector-gateway",
      kind: "External Harness Connector Crate",
      paths: "rust/omnia-connector-gateway/src/lib.rs",
      manifestPath: "rust/omnia-connector-gateway/Cargo.toml",
      entryFile: "rust/omnia-connector-gateway/src/lib.rs",
      sdkLibs: ["omnia-core", "reqwest / Tokio"],
      summary: "Truthful adapter readiness probes and gated dispatch for OpenCode, CodexPatched, ProxyRouter, and ArtifactIntake without fabricated connected states.",
      code:
        "pub enum ConnectorStatus { Ready, Unconfigured, Unavailable, Blocked }\n" +
        "pub struct ConnectorProbeResult {\n" +
        "    pub id: String,\n" +
        "    pub status: ConnectorStatus,\n" +
        "    pub reason: String,\n" +
        "}"
    },
    {
      id: "omnia-workspace-ops",
      title: "omnia-workspace-ops",
      kind: "Read-Only Workspace Tree, File & Diff Crate",
      paths: "rust/omnia-workspace-ops/src/lib.rs",
      manifestPath: "rust/omnia-workspace-ops/Cargo.toml",
      entryFile: "rust/omnia-workspace-ops/src/lib.rs",
      sdkLibs: ["omnia-core", "path_guard", "fs_ops"],
      summary: "Reparse-point-safe canonical path guard, bounded directory tree enumeration, line-range file slice reader with SHA-256, and unified diff generator.",
      code:
        "pub fn list_tree(root: &Path, rel: &str, max_depth: usize) -> Result<Vec<TreeEntry>, WorkspaceError>;\n" +
        "pub fn read_file_slice(root: &Path, rel: &str, start_line: Option<usize>, end_line: Option<usize>) -> Result<FileSlice, WorkspaceError>;\n" +
        "pub fn unified_diff(before: &str, after: &str, context: usize) -> DiffOutput;"
    },
    {
      id: "omnia-media-capture",
      title: "omnia-media-capture",
      kind: "Media & Screen Readiness Probe Crate",
      paths: "rust/omnia-media-capture/src/lib.rs",
      manifestPath: "rust/omnia-media-capture/Cargo.toml",
      entryFile: "rust/omnia-media-capture/src/lib.rs",
      sdkLibs: ["Browser CDP", "Win32 Capture", "OBS v5"],
      summary: "Truthful readiness diagnostics across Browser CDP, Win32 Window Capture, and OBS WebSocket v5 reporting explicit reason_code and source_verified.",
      code:
        "pub struct CapabilityReport {\n" +
        "    pub adapter: String,\n" +
        "    pub status: CapabilityStatus,\n" +
        "    pub reason_code: String,\n" +
        "    pub source_verified: bool,\n" +
        "}"
    },
    {
      id: "omnia-remote-control",
      title: "omnia-remote-control",
      kind: "Pairing, Lease & Replay-Window Crate",
      paths: "rust/omnia-remote-control/src/lib.rs",
      manifestPath: "rust/omnia-remote-control/Cargo.toml",
      entryFile: "rust/omnia-remote-control/src/lib.rs",
      sdkLibs: ["omnia-core", "HMAC / Replay Window"],
      summary: "Loopback-scoped remote pairing protocol, expiring signed execution leases, and monotonic nonce replay-window protection.",
      code:
        "pub struct RemoteLeaseState {\n" +
        "    pub pairing_required: bool,\n" +
        "    pub active_leases: usize,\n" +
        "    pub replay_window_ms: u64,\n" +
        "}"
    },
    {
      id: "omnia-runtime",
      title: "omnia-runtime",
      kind: "Unified Rust Runtime Daemon",
      paths: "rust/omnia-runtime/src/main.rs",
      manifestPath: "rust/omnia-runtime/Cargo.toml",
      entryFile: "rust/omnia-runtime/src/main.rs",
      sdkLibs: ["Tokio", "Hyper", "omnia-storage", "omnia-routing"],
      summary: "Native async Tokio/Hyper runtime orchestrating health, capabilities, provider routing, skills search, NVIDIA telemetry, and streaming chat.",
      code:
        "// Native Tokio/Hyper runtime host (127.0.0.1 loopback)\n" +
        "async fn handle_request(req: Request<Incoming>) -> Result<Response<Full<Bytes>>, Infallible> {\n" +
        "    // routes /api/health, /api/capabilities, /api/providers, /api/chat\n" +
        "}"
    },
    {
      id: "omnia-studio",
      title: "omnia-studio",
      kind: "Tokio/Hyper Studio HTTP Server",
      paths: "rust/omnia-studio/src/main.rs",
      manifestPath: "rust/omnia-studio/Cargo.toml",
      entryFile: "rust/omnia-studio/src/main.rs",
      sdkLibs: ["Tokio", "Hyper", "omnia-workspace-ops", "omnia-graph", "omnia-harness"],
      summary: "Full Native Rust Studio HTTP server on 127.0.0.1:<port> with strict Origin allowlist (403 on foreign POST) serving Obsidian Kinetic Atelier UI.",
      code:
        "// Strict 127.0.0.1 loopback bind + Cross-Origin POST mutation rejection\n" +
        "if req.method() == Method::POST && !is_loopback_origin(origin) {\n" +
        "    return json_response(StatusCode::FORBIDDEN, json!({\"ok\": false, \"error\": \"forbidden_origin\"}));\n" +
        "}"
    },
    {
      id: "omnia-native",
      title: "omnia-native",
      kind: "Win32 + Direct2D + COM UIA Desktop Shell",
      paths: "rust/omnia-native/src/main.rs",
      manifestPath: "rust/omnia-native/Cargo.toml",
      entryFile: "rust/omnia-native/src/main.rs",
      sdkLibs: ["Direct2D", "DirectWrite", "UIA", "winsqlite3", "DWM Mica"],
      summary: "Native Windows 11 desktop shell with DWM Dark/Mica backdrop, server-side COM IRawElementProviderSimple + IValueProvider + modal UIA support.",
      code:
        "// Server-side COM UIA provider exposing ControlType.Edit (UIA_EditControlTypeId)\n" +
        "fn get_provider_options() -> ProviderOptions {\n" +
        "    ProviderOptions_ServerSideProvider | ProviderOptions_UseComThreading\n" +
        "}"
    }
  ];

  const ideState = {
    selectedModId: "omnia-studio",
    treePath: ".",
    treeData: null,
    selectedFilePath: "Cargo.toml",
    fileData: null,
    diffData: null,
    graphCodeData: null
  };

  function parentRelPath(relPath) {
    const clean = String(relPath || ".").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!clean || clean === ".") return null;
    const idx = clean.lastIndexOf("/");
    return idx <= 0 ? "." : clean.slice(0, idx);
  }

  function renderRustExplorer() {
    const tabsEl = document.getElementById("rustModuleSelectorList");
    const detailEl = document.getElementById("rustModuleDetailCard");
    if (!tabsEl || !detailEl) return;

    tabsEl.innerHTML = RUST_CRATES.map((m) => (
      '<button type="button" class="btn ' + (m.id === ideState.selectedModId ? "btn-primary" : "btn-subtle") +
        '" style="min-height:30px;padding:0 10px;font-size:11.5px;" data-rust-mod="' + escapeHtml(m.id) + '">' +
        escapeHtml(m.title) +
      "</button>"
    )).join("");

    const mod = RUST_CRATES.find((m) => m.id === ideState.selectedModId) || RUST_CRATES[0];
    detailEl.innerHTML =
      '<div class="row-between">' +
        '<div>' +
          '<div style="font-size:1rem;font-weight:700;">' + escapeHtml(mod.title) + "</div>" +
          '<div class="mono muted" style="font-size:11px;">' + escapeHtml(mod.paths) + "</div>" +
        "</div>" +
        '<span class="badge badge-amber">' + escapeHtml(mod.kind) + "</span>" +
      "</div>" +
      '<p style="margin:6px 0;font-size:12.5px;color:var(--ink-secondary);line-height:1.55;">' + escapeHtml(mod.summary) + "</p>" +
      '<div class="row-wrap" style="margin-bottom:8px;">' +
        mod.sdkLibs.map((lib) => '<span class="badge badge-cyan">⚙ ' + escapeHtml(lib) + "</span>").join("") +
      "</div>" +
      '<div class="code-frame">' +
        '<div class="code-frame-bar">' +
          '<span>Rust Crate Contract (rustc 1.99.1 • Workspace Crate)</span>' +
          '<div class="row-wrap">' +
            '<button type="button" class="btn btn-subtle" style="min-height:24px;padding:0 8px;font-size:11px;" data-open-ws-file="' + escapeHtml(mod.manifestPath) + '">Cargo.toml</button>' +
            '<button type="button" class="btn btn-subtle" style="min-height:24px;padding:0 8px;font-size:11px;" data-open-ws-file="' + escapeHtml(mod.entryFile) + '">Open Source ↗</button>' +
            '<button type="button" class="btn btn-subtle" style="min-height:24px;padding:0 8px;font-size:11px;" id="btnJumpGraphifyFromMod" data-target-entity="' + escapeHtml(mod.id) + '">Code Graph ↗</button>' +
          "</div>" +
        "</div>" +
        '<pre class="code-pre">' + highlightCode(mod.code) + "</pre>" +
      "</div>";

    detailEl.querySelectorAll("[data-open-ws-file]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetFile = btn.getAttribute("data-open-ws-file");
        if (targetFile) openWorkspaceFile(targetFile);
      });
    });

    const jumpBtn = document.getElementById("btnJumpGraphifyFromMod");
    if (jumpBtn) {
      jumpBtn.addEventListener("click", () => {
        const entityInput = document.getElementById("codeGraphEntityInput");
        if (entityInput) entityInput.value = mod.id;
        loadCodeGraph(mod.id);
      });
    }
  }

  function renderWorkspaceTree() {
    const listEl = document.getElementById("wsTreeList");
    const statusEl = document.getElementById("wsTreeMeta");
    const pathInput = document.getElementById("wsTreePathInput");
    if (!listEl) return;
    if (pathInput) pathInput.value = ideState.treePath;

    const data = ideState.treeData;
    if (!data) {
      if (statusEl) statusEl.textContent = "Probing workspace tree…";
      listEl.innerHTML = '<div class="muted mono" style="font-size:11px;">Loading /api/workspace/tree…</div>';
      return;
    }

    if (data.state === "unavailable" || data.ok === false) {
      const codeLabel = data.httpStatus ? ("HTTP " + data.httpStatus) : "OFFLINE";
      if (statusEl) statusEl.textContent = codeLabel + " • " + (data.error || "unavailable");
      listEl.innerHTML =
        '<div class="stack-xs">' +
          '<span class="badge badge-coral">WORKSPACE TREE UNAVAILABLE (' + escapeHtml(codeLabel) + ")</span>" +
          '<div class="mono muted" style="font-size:11px;">' +
            escapeHtml(data.message || data.error || "workspace_tree_unavailable") +
          "</div>" +
        "</div>";
      return;
    }

    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (statusEl) {
      statusEl.textContent = entries.length + " entries" + (data.root ? " • " + data.root : "");
    }

    const parts = [];
    const up = parentRelPath(ideState.treePath);
    if (up !== null) {
      parts.push(
        '<button type="button" class="workspace-tree-entry" data-ws-dir="' + escapeHtml(up) + '">' +
          '<span>📁 .. (parent: ' + escapeHtml(up) + ')</span>' +
          '<span class="muted">dir</span>' +
        "</button>"
      );
    }

    if (!entries.length) {
      parts.push('<div class="muted mono" style="font-size:11px;padding:6px;">Directory returned 0 entries.</div>');
    } else {
      entries.forEach((entry) => {
        const isDir = entry.kind === "dir";
        const isActive = !isDir && entry.path === ideState.selectedFilePath;
        const icon = isDir ? "📁 " : "📄 ";
        const meta = isDir ? "dir" : formatBytes(entry.bytes || 0);
        const attr = isDir
          ? ('data-ws-dir="' + escapeHtml(entry.path) + '"')
          : ('data-ws-file="' + escapeHtml(entry.path) + '"');
        parts.push(
          '<button type="button" class="workspace-tree-entry' + (isActive ? " active" : "") + '" ' + attr + ">" +
            '<span class="truncate">' + icon + escapeHtml(entry.path) + "</span>" +
            '<span class="muted">' + escapeHtml(meta) + "</span>" +
          "</button>"
        );
      });
    }
    listEl.innerHTML = parts.join("");
  }

  function renderWorkspaceFile() {
    const metaEl = document.getElementById("wsFileHeaderMeta");
    const preEl = document.getElementById("wsFileContentPre");
    const pathInput = document.getElementById("wsFilePathInput");
    if (!preEl) return;
    if (pathInput && ideState.selectedFilePath) pathInput.value = ideState.selectedFilePath;

    const file = ideState.fileData;
    if (!file) {
      if (metaEl) metaEl.textContent = "Select a file from tree or enter path (e.g. Cargo.toml)";
      preEl.innerHTML = '<span class="muted">Read-only workspace viewer awaits /api/workspace/file response.</span>';
      return;
    }

    if (file.state === "unavailable" || file.ok === false) {
      const codeLabel = file.httpStatus ? ("HTTP " + file.httpStatus) : "OFFLINE";
      if (metaEl) metaEl.textContent = codeLabel + " • " + (file.relativePath || ideState.selectedFilePath);
      preEl.innerHTML =
        '<div class="stack-xs">' +
          '<span class="badge badge-coral">FILE READ UNAVAILABLE (' + escapeHtml(codeLabel) + ")</span>" +
          '<div class="muted" style="font-size:11px;">' +
            escapeHtml(file.message || file.error || "workspace_file_unavailable") +
          "</div>" +
        "</div>";
      return;
    }

    const shaShort = file.sha256 ? ("sha256:" + String(file.sha256).slice(0, 12)) : "sha256:unreported";
    if (metaEl) {
      metaEl.textContent = (file.relativePath || ideState.selectedFilePath) + " • " +
        (file.lineCount || 0) + " lines • " + shaShort;
    }

    const lines = Array.isArray(file.lines) && file.lines.length
      ? file.lines
      : String(file.content || "").split(/\r?\n/).map((text, idx) => ({ lineNumber: idx + 1, text }));

    if (!lines.length) {
      preEl.innerHTML = '<span class="muted">(empty file)</span>';
      return;
    }

    preEl.innerHTML = lines.map((row) => (
      '<div><span class="workspace-line-num">' + escapeHtml(String(row.lineNumber)) + "</span>" +
      highlightCode(row.text) + "</div>"
    )).join("");
  }

  function renderWorkspaceDiff() {
    const outEl = document.getElementById("wsDiffOutput");
    if (!outEl) return;
    const diff = ideState.diffData;
    if (!diff) {
      outEl.innerHTML = '<div class="muted mono" style="font-size:11px;">Submit before/after snapshots to preview read-only unified diff via POST /api/workspace/diff.</div>';
      return;
    }
    if (diff.state === "unavailable" || diff.ok === false) {
      const codeLabel = diff.httpStatus ? ("HTTP " + diff.httpStatus) : "OFFLINE";
      outEl.innerHTML =
        '<div class="atelier-card stack-xs">' +
          '<span class="badge badge-coral">DIFF PREVIEW UNAVAILABLE (' + escapeHtml(codeLabel) + ")</span>" +
          '<span class="mono muted" style="font-size:11px;">' +
            escapeHtml(diff.message || diff.error || "workspace_diff_unavailable") +
          "</span>" +
        "</div>";
      return;
    }

    const rawLines = String(diff.unifiedDiff || "").split(/\r?\n/);
    const diffHtml = rawLines.map((line) => {
      if (line.startsWith("@@")) {
        return '<span class="diff-line-hunk">' + escapeHtml(line) + "</span>";
      }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        return '<span class="diff-line-add">' + escapeHtml(line) + "</span>";
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        return '<span class="diff-line-del">' + escapeHtml(line) + "</span>";
      }
      return '<span class="diff-line-ctx">' + escapeHtml(line || " ") + "</span>";
    }).join("");

    outEl.innerHTML =
      '<div class="row-wrap" style="margin-bottom:6px;">' +
        '<span class="badge badge-emerald">+' + escapeHtml(String(diff.additions)) + " additions</span>" +
        '<span class="badge badge-coral">-' + escapeHtml(String(diff.deletions)) + " deletions</span>" +
        '<span class="badge badge-cyan">' + escapeHtml(String(diff.hunks)) + " hunks</span>" +
      "</div>" +
      '<div class="code-frame"><pre class="workspace-code-lines" style="max-height:240px;">' + diffHtml + "</pre></div>";
  }

  function renderCodeGraph() {
    const out = document.getElementById("codeGraphOutput");
    if (!out) return;
    const data = ideState.graphCodeData;
    if (!data) {
      out.innerHTML = '<div class="muted mono" style="font-size:11px;">Query live /api/graph/code to inspect extracted crate &amp; symbol provenance edges.</div>';
      return;
    }
    if (data.state === "unavailable" || data.ok === false) {
      const codeLabel = data.httpStatus ? ("HTTP " + data.httpStatus) : "OFFLINE";
      out.innerHTML =
        '<div class="atelier-card stack-xs">' +
          '<span class="badge badge-coral">CODE GRAPH UNAVAILABLE (' + escapeHtml(codeLabel) + ")</span>" +
          '<span class="mono muted" style="font-size:11px;">' +
            escapeHtml(data.message || data.error || "graph_code_unavailable") +
          "</span>" +
        "</div>";
      return;
    }

    const edges = Array.isArray(data.edges) ? data.edges : [];
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    const matches = Array.isArray(data.matches) ? data.matches : [];
    const rowsHtml = edges.slice(0, 24).map((edge) => {
      const prov = String(edge.provenance || "EXTRACTED").toUpperCase();
      const cls = prov === "EXTRACTED" ? "badge-extracted" : (prov === "AMBIGUOUS" ? "badge-ambiguous" : "badge-inferred");
      return (
        '<div class="row-between" style="padding:4px 0;border-bottom:1px solid var(--border-subtle);font-size:11px;">' +
          '<span class="mono">' + escapeHtml(edge.from || edge.source || "") + " → " +
            escapeHtml(edge.to || edge.target || "") +
            (edge.relation ? " (" + escapeHtml(edge.relation) + ")" : "") +
          "</span>" +
          '<span class="badge ' + cls + '">' + escapeHtml(prov) + "</span>" +
        "</div>"
      );
    }).join("");

    out.innerHTML =
      '<div class="row-wrap" style="margin-bottom:6px;">' +
        '<span class="badge badge-cyan">Nodes: ' + escapeHtml(String(nodes.length)) + "</span>" +
        '<span class="badge badge-emerald">Edges: ' + escapeHtml(String(edges.length)) + "</span>" +
        (matches.length ? '<span class="badge badge-amber">Matches: ' + escapeHtml(String(matches.length)) + "</span>" : "") +
      "</div>" +
      (data.summary ? '<div class="muted" style="font-size:11.5px;margin-bottom:6px;">' + escapeHtml(data.summary) + "</div>" : "") +
      (rowsHtml || '<div class="muted mono" style="font-size:11px;">0 edges returned for selected filter.</div>');
  }

  async function loadWorkspaceTree(relPath, maxDepth) {
    ideState.treePath = String(relPath == null ? "." : relPath).trim() || ".";
    ideState.treeData = await Studio.api.getWorkspaceTree(ideState.treePath, maxDepth || 3);
    renderWorkspaceTree();
  }

  async function openWorkspaceFile(relPath, startLine, endLine) {
    const clean = String(relPath || "").trim();
    if (!clean) return;
    ideState.selectedFilePath = clean;
    ideState.fileData = await Studio.api.getWorkspaceFile(clean, startLine, endLine);
    renderWorkspaceTree();
    renderWorkspaceFile();
  }

  async function runWorkspaceDiff() {
    const beforeEl = document.getElementById("wsDiffBefore");
    const afterEl = document.getElementById("wsDiffAfter");
    const ctxEl = document.getElementById("wsDiffContextLines");
    const beforeText = beforeEl ? beforeEl.value : "";
    const afterText = afterEl ? afterEl.value : "";
    const ctx = ctxEl && Number.isFinite(Number(ctxEl.value)) ? Number(ctxEl.value) : 3;
    ideState.diffData = await Studio.api.diffWorkspace(beforeText, afterText, ctx);
    renderWorkspaceDiff();
  }

  async function loadCodeGraph(entityOverride) {
    const entityEl = document.getElementById("codeGraphEntityInput");
    const dirEl = document.getElementById("codeGraphDirSelect");
    const entity = entityOverride !== undefined ? entityOverride : (entityEl ? entityEl.value.trim() : "");
    const dir = dirEl ? dirEl.value : "both";
    ideState.graphCodeData = await Studio.api.getGraphCode(entity, dir, 2);
    renderCodeGraph();
  }

  function renderRagPlanResult(plan) {
    const out = document.getElementById("ragAnalysisOutput");
    if (!out || !plan) return;
    if (plan.state === "unavailable" || plan.ok === false) {
      const codeLabel = plan.httpStatus ? (" • HTTP " + plan.httpStatus) : "";
      out.innerHTML = '<div class="atelier-card stack-sm">' +
        '<span class="badge badge-coral">RAG PLANNER / QUERY UNAVAILABLE' + escapeHtml(codeLabel) + "</span>" +
        '<span class="mono muted" style="font-size:11px;">' +
          escapeHtml(plan.message || plan.error || "rag_plan_endpoint_unavailable") +
        "</span></div>";
      return;
    }
    const uncertainty = Number(plan.uncertaintyScore);
    const hasUncertainty = Number.isFinite(uncertainty);
    const pct = hasUncertainty ? Math.round(uncertainty * 100) : null;
    const retrievalLabel = typeof plan.shouldRetrieve === "boolean"
      ? (plan.shouldRetrieve ? "PROACTIVE RETRIEVAL TRIGGERED" : "DIRECT RESPONSE")
      : "RAG QUERY RESULT";

    const triggersHtml = (plan.triggers || []).map((t) => (
      '<span class="badge badge-amber">⚡ ' + escapeHtml(t) + "</span>"
    )).join("");

    const subQHtml = (plan.subQueries || []).map((sq, idx) => (
      '<div class="atelier-card" style="padding:8px 10px;">' +
        '<div class="mono" style="font-size:11px;color:var(--accent-cyan);">Angle ' + (idx + 1) + " • " + escapeHtml(sq.angle || "Sub-query") + "</div>" +
        '<div style="font-size:12.5px;margin-top:2px;">' + escapeHtml(sq.query || String(sq)) + "</div>" +
      "</div>"
    )).join("");

    const citedHtml = (plan.citedSources || []).map((src) => (
      '<div class="atelier-card" style="padding:8px 10px;">' +
        '<div class="row-between">' +
          '<strong style="font-size:12px;">' + escapeHtml(src.title || src.path || "Source") + "</strong>" +
          '<span class="badge ' + (src.provenance === "EXTRACTED"
            ? "badge-extracted"
            : (src.provenance === "INFERRED" ? "badge-inferred" : "badge-cyan")) + '">' +
            escapeHtml(src.provenance || "PROVENANCE UNKNOWN") + " • " +
            escapeHtml(src.score ?? "score unavailable") +
          "</span>" +
        "</div>" +
        '<div class="mono muted" style="font-size:10.5px;margin:2px 0;">' + escapeHtml(src.locator || src.path || "") + "</div>" +
        '<div style="font-size:12px;color:var(--ink-secondary);">' + escapeHtml(src.snippet || "") + "</div>" +
      "</div>"
    )).join("");

    const hitsHtml = (plan.hits || []).map((hit) => (
      '<div class="atelier-card" style="padding:8px 10px;">' +
        '<div class="row-between">' +
          '<strong class="mono" style="font-size:11.5px;">' + escapeHtml(hit.path || hit.title || hit.id || "Hit") + "</strong>" +
          '<span class="badge badge-cyan">' + escapeHtml(hit.score != null ? String(hit.score) : "match") + "</span>" +
        "</div>" +
        '<div style="font-size:12px;color:var(--ink-secondary);margin-top:3px;">' + escapeHtml(hit.snippet || hit.text || "") + "</div>" +
      "</div>"
    )).join("");

    const unusedHtml = (plan.unusedSources || []).map((u) => (
      '<div style="padding:7px 10px;border:1px solid var(--status-coral-border);background:var(--status-coral-tint);border-radius:4px;font-size:11.5px;">' +
        '<div class="row-between">' +
          '<strong class="mono">' + escapeHtml(u.title) + "</strong>" +
          '<span class="badge badge-coral">QUARANTINED / UNUSED</span>' +
        "</div>" +
        '<div class="muted mono" style="font-size:10.5px;">' + escapeHtml(u.locator || "") + "</div>" +
        '<div style="margin-top:2px;">' + escapeHtml(u.reason) + "</div>" +
      "</div>"
    )).join("");

    const uncertaintyMeter = hasUncertainty
      ? '<div class="meter-bar"><div class="meter-fill" style="width:' + pct + '%;background:' + (pct >= 55 ? "var(--accent-amber)" : "var(--status-emerald)") + ';"></div></div>'
      : '<div class="mono muted" style="font-size:11px;">Uncertainty score not reported by active endpoint.</div>';

    out.innerHTML =
      '<div class="atelier-card-elevated stack-sm">' +
        '<div class="row-between">' +
          '<div class="row-wrap">' +
            '<span class="badge ' + (plan.shouldRetrieve === true ? "badge-emerald" : (plan.shouldRetrieve === false ? "badge-cyan" : "badge-amber")) + '">' +
              retrievalLabel +
            "</span>" +
            '<span class="badge badge-cyan">Lang: ' + escapeHtml(plan.language || "auto") + "</span>" +
          "</div>" +
          '<span class="mono" style="font-weight:700;">Uncertainty: ' +
            (hasUncertainty ? escapeHtml(pct + "% (" + plan.uncertaintyScore + ")") : "unreported") +
          "</span>" +
        "</div>" +
        uncertaintyMeter +
        (plan.answer ? '<div style="font-size:12.5px;color:var(--ink-primary);">' + escapeHtml(plan.answer) + "</div>" : "") +
        '<div class="row-wrap">' + triggersHtml + "</div>" +
      "</div>" +

      (subQHtml ? '<div class="stack-xs"><div class="section-eyebrow">Decomposed Multi-Angle Sub-Queries (' + (plan.subQueries || []).length + ")</div>" + subQHtml + "</div>" : "") +
      (citedHtml ? '<div class="stack-xs"><div class="section-eyebrow">Cited Grounded Sources (' + (plan.citedSources || []).length + ")</div>" + citedHtml + "</div>" : "") +
      (hitsHtml ? '<div class="stack-xs"><div class="section-eyebrow">RAG Retrieval Hits (' + (plan.hits || []).length + ")</div>" + hitsHtml + "</div>" : "") +
      (unusedHtml ? '<div class="stack-xs"><div class="section-eyebrow">Explicit Quarantined / Unused Sources (' + (plan.unusedSources || []).length + ")</div>" + unusedHtml + "</div>" : "");
  }

  async function runRagAnalyzer(queryOverride) {
    const input = document.getElementById("ragQueryInput");
    if (queryOverride && input) input.value = queryOverride;
    const q = input ? input.value.trim() : "";
    if (!q) return;
    const plan = await Studio.api.planRag(q);
    renderRagPlanResult(plan);
  }

  async function init() {
    renderRustExplorer();
    renderWorkspaceTree();
    renderWorkspaceFile();
    renderWorkspaceDiff();
    renderCodeGraph();

    const modList = document.getElementById("rustModuleSelectorList");
    if (modList) {
      modList.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-rust-mod]");
        if (!btn) return;
        ideState.selectedModId = btn.getAttribute("data-rust-mod");
        renderRustExplorer();
      });
    }

    const treeForm = document.getElementById("wsTreeForm");
    if (treeForm) {
      treeForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = document.getElementById("wsTreePathInput");
        const depthEl = document.getElementById("wsTreeMaxDepth");
        loadWorkspaceTree(input ? input.value : ".", depthEl ? Number(depthEl.value) : 3);
      });
    }

    document.querySelectorAll("[data-ws-quick-tree]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const rel = btn.getAttribute("data-ws-quick-tree") || ".";
        loadWorkspaceTree(rel, 3);
      });
    });

    document.querySelectorAll("[data-ws-quick-file]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const rel = btn.getAttribute("data-ws-quick-file");
        if (rel) openWorkspaceFile(rel);
      });
    });

    const treeList = document.getElementById("wsTreeList");
    if (treeList) {
      treeList.addEventListener("click", (e) => {
        const dirBtn = e.target.closest("[data-ws-dir]");
        if (dirBtn) {
          const depthEl = document.getElementById("wsTreeMaxDepth");
          loadWorkspaceTree(dirBtn.getAttribute("data-ws-dir"), depthEl ? Number(depthEl.value) : 3);
          return;
        }
        const fileBtn = e.target.closest("[data-ws-file]");
        if (fileBtn) {
          openWorkspaceFile(fileBtn.getAttribute("data-ws-file"));
        }
      });
    }

    const fileForm = document.getElementById("wsFileForm");
    if (fileForm) {
      fileForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const pathEl = document.getElementById("wsFilePathInput");
        const startEl = document.getElementById("wsFileStartLine");
        const endEl = document.getElementById("wsFileEndLine");
        openWorkspaceFile(
          pathEl ? pathEl.value : "",
          startEl && startEl.value ? Number(startEl.value) : null,
          endEl && endEl.value ? Number(endEl.value) : null
        );
      });
    }

    const useBeforeBtn = document.getElementById("btnWsDiffLoadBefore");
    if (useBeforeBtn) {
      useBeforeBtn.addEventListener("click", () => {
        const beforeEl = document.getElementById("wsDiffBefore");
        if (beforeEl && ideState.fileData && typeof ideState.fileData.content === "string") {
          beforeEl.value = ideState.fileData.content;
        }
      });
    }

    const useAfterBtn = document.getElementById("btnWsDiffLoadAfter");
    if (useAfterBtn) {
      useAfterBtn.addEventListener("click", () => {
        const afterEl = document.getElementById("wsDiffAfter");
        if (afterEl && ideState.fileData && typeof ideState.fileData.content === "string") {
          afterEl.value = ideState.fileData.content;
        }
      });
    }

    const diffForm = document.getElementById("wsDiffForm");
    if (diffForm) {
      diffForm.addEventListener("submit", (e) => {
        e.preventDefault();
        runWorkspaceDiff();
      });
    }

    const codeGraphForm = document.getElementById("codeGraphForm");
    if (codeGraphForm) {
      codeGraphForm.addEventListener("submit", (e) => {
        e.preventDefault();
        loadCodeGraph();
      });
    }

    const ragForm = document.getElementById("ragAnalyzeForm");
    if (ragForm) {
      ragForm.addEventListener("submit", (e) => {
        e.preventDefault();
        runRagAnalyzer();
      });
    }

    document.querySelectorAll("[data-rag-sample]").forEach((btn) => {
      btn.addEventListener("click", () => {
        runRagAnalyzer(btn.getAttribute("data-rag-sample"));
      });
    });

    await Promise.all([
      loadWorkspaceTree(".", 3),
      openWorkspaceFile("Cargo.toml", 1, 120)
    ]);
  }

  Studio.ideExplorer = {
    init,
    selectModule(modId) {
      if (RUST_CRATES.some((m) => m.id === modId)) {
        ideState.selectedModId = modId;
        renderRustExplorer();
      }
    },
    loadWorkspaceTree,
    openWorkspaceFile,
    runWorkspaceDiff,
    loadCodeGraph,
    runRagAnalyzer
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
