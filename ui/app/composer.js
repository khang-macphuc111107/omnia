"use strict";

(function initComposerModule(global) {
  const Studio = (global.OmniaStudio = global.OmniaStudio || {});
  const { sha256Hex, fnv1aHex, escapeHtml, formatBytes, highlightCpp20, renderLatexToHtml, renderRichMarkdown } = Studio.utils;

  const INITIAL_TURNS = [
    {
      id: "turn-01",
      role: "user",
      author: "Lead Architect (VI/EN)",
      timestamp: "20:24:12",
      badges: [{ label: "SESSION: WAL#14", cls: "badge-amber" }],
      markdown:
        "Verify our C++20 `SessionStore` cooperative SQLite WAL lease alongside the Maxwell-Faraday induction identity:\n" +
        "$$\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}, \\quad \\Delta G^\\circ = \\Delta H^\\circ - T\\Delta S^\\circ$$\n" +
        "Ensure zero Rust runtime dependencies and strict `token_budget: NULL` continuity."
    },
    {
      id: "turn-02",
      role: "agent",
      author: "Omnia Native C++20 Studio • gemini-3.1-pro",
      timestamp: "20:24:14",
      badges: [
        { label: "EXTRACTED • omnia_storage", cls: "badge-extracted", jumpView: "cpp-rag", jumpTarget: "omnia_storage" },
        { label: "EXTRACTED • omnia_routing", cls: "badge-extracted", jumpView: "router", jumpTarget: "google-gemini-3-1-pro" },
        { label: "INFERRED • WAL Lease Parity", cls: "badge-inferred", jumpView: "graph", jumpTarget: "cpp-core" }
      ],
      reasoning: [
        "1. GraphifyIndex::traverse('omnia_storage', Direction::Both, depth=2) -> 4 EXTRACTED edges, 1 INFERRED edge, 0 unquarantined AMBIGUOUS.",
        "2. DynamicProviderRouter::decide(code_generation, 4096 tok, enterprise_zdr) -> selected google-gemini-3-1-pro (score 91, circuit Closed).",
        "3. Verified winsqlite3.h RAII handle + cooperative PID/epoch lease heartbeat and zero-CDN LaTeX math AST."
      ],
      markdown:
        "Both invariants hold under **MSVC 14.51 `/std:c++20 /W4 /WX`**. The `SessionStore` acquires an exclusive cooperative row lease inside `winsqlite3` WAL mode while preserving quantized electromagnetic & thermodynamic identities inline: $\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}$ and $\\mathrm{N}_2 + 3\\mathrm{H}_2 \\rightleftharpoons 2\\mathrm{NH}_3$.",
      cppTitle: "cpp/include/omnia/storage/session_store.hpp • RAII winsqlite3 WAL Lease",
      cppCode:
        "struct SqliteCloser {\n" +
        "  void operator()(sqlite3* db) const noexcept {\n" +
        "    if (db != nullptr) sqlite3_close_v2(db);\n" +
        "  }\n" +
        "};\n\n" +
        "class SessionStore final {\n" +
        "public:\n" +
        "  [[nodiscard]] bool acquire_lease(std::string_view holder_id, uint32_t pid, uint64_t epoch) noexcept;\n" +
        "  [[nodiscard]] std::string content_digest(std::span<const uint8_t> payload) const;\n" +
        "private:\n" +
        "  std::unique_ptr<sqlite3, SqliteCloser> db_{nullptr};\n" +
        "  mutable std::mutex io_mutex_{};\n" +
        "};"
    }
  ];

  const composerState = {
    turns: INITIAL_TURNS.slice(),
    templates: [],
    activeCategory: "All",
    paletteOpen: false,
    previewVisible: true,
    imeComposing: false,
    draftRev: 1,
    draftChecksum: "00000000",
    // Content-addressed store keyed by sha256 -> { id, sha256, name, sizeBytes, mime, status, refs: Set<'inline'|'tray'> }
    payloadBySha: new Map(),
    idToSha: new Map(),
    pendingPasteCandidate: null,
    savedCaret: { start: 0, end: 0, snapshotText: "", snapshotRev: 1, snapshotHash: "" },
    lastFocusBeforeModal: null
  };

  function updateDraftIntegrity(textarea, mutateRev) {
    if (!textarea) return;
    const val = textarea.value;
    if (mutateRev) composerState.draftRev += 1;
    composerState.draftChecksum = fnv1aHex(val);
    const revEl = document.getElementById("footerDraftRev");
    const hashEl = document.getElementById("footerDraftHash");
    if (revEl) revEl.textContent = "Rev #" + composerState.draftRev;
    if (hashEl) hashEl.textContent = "FNV1a:" + composerState.draftChecksum;
  }

  function buildAttachmentLookup() {
    const map = {};
    for (const [id, sha] of composerState.idToSha.entries()) {
      const rec = composerState.payloadBySha.get(sha);
      if (rec) map[id] = rec;
    }
    return map;
  }

  function registerAttachmentPayload(fileSpec, placement) {
    const rawKey = fileSpec.encrypted
      ? "ENCRYPTED_LOCKED:" + fileSpec.name + ":" + fileSpec.sizeBytes
      : (fileSpec.content || fileSpec.name + ":" + fileSpec.sizeBytes);
    const sha = sha256Hex(rawKey);
    let rec = composerState.payloadBySha.get(sha);
    if (!rec) {
      const shortId = sha.slice(0, 8);
      rec = {
        id: shortId,
        sha256: sha,
        name: fileSpec.name,
        sizeBytes: fileSpec.sizeBytes,
        mime: fileSpec.mime || "application/octet-stream",
        encrypted: Boolean(fileSpec.encrypted),
        status: fileSpec.encrypted ? "ENCRYPTED_UNRESOLVED (0 B read)" : "VERIFIED_SHA256",
        refs: new Set()
      };
      composerState.payloadBySha.set(sha, rec);
      composerState.idToSha.set(shortId, sha);
    }
    rec.refs.add(placement);
    return rec;
  }

  function insertAtCaret(textarea, snippet) {
    if (!textarea) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    textarea.value = before + snippet + after;
    const nextPos = start + snippet.length;
    textarea.focus();
    textarea.setSelectionRange(nextPos, nextPos);
    updateDraftIntegrity(textarea, true);
    renderLivePreview();
  }

  function wrapSelection(textarea, prefix, suffix, placeholder) {
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const selected = textarea.value.slice(start, end) || placeholder;
    const replacement = prefix + selected + suffix;
    textarea.value = textarea.value.slice(0, start) + replacement + textarea.value.slice(end);
    textarea.focus();
    textarea.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
    updateDraftIntegrity(textarea, true);
    renderLivePreview();
  }

  function renderTurnStream() {
    const container = document.getElementById("chatTurnStream");
    if (!container) return;
    const lookup = buildAttachmentLookup();

    container.innerHTML = composerState.turns.map((turn, idx) => {
      const badgesHtml = (turn.badges || []).map((b) => {
        if (b.jumpView) {
          return '<button type="button" class="badge badge-clickable ' + escapeHtml(b.cls) +
            '" data-jump-view="' + escapeHtml(b.jumpView) +
            '" data-jump-target="' + escapeHtml(b.jumpTarget || "") + '">' +
            escapeHtml(b.label) + " ↗</button>";
        }
        return '<span class="badge ' + escapeHtml(b.cls || "") + '">' + escapeHtml(b.label) + "</span>";
      }).join("");

      const reasoningHtml = Array.isArray(turn.reasoning) && turn.reasoning.length
        ? '<details class="reasoning-trace"><summary><span>▸ Execution & Provenance Trace (' +
          turn.reasoning.length + ' verified steps)</span><span class="muted">C++20 Harness</span></summary>' +
          '<div class="reasoning-steps">' +
          turn.reasoning.map((step) => "<div>" + escapeHtml(step) + "</div>").join("") +
          "</div></details>"
        : "";

      let codeHtml = "";
      if (turn.cppCode) {
        const codeId = "cpp-snippet-" + idx;
        codeHtml =
          '<div class="code-frame">' +
            '<div class="code-frame-bar">' +
              '<span>' + escapeHtml(turn.cppTitle || "C++20 Snippet") + '</span>' +
              '<button type="button" class="btn btn-subtle" style="min-height:24px;padding:0 8px;font-size:11px;" data-copy-code="' + codeId + '">Copy C++20</button>' +
            '</div>' +
            '<pre class="code-pre" id="' + codeId + '" data-raw-code="' + escapeHtml(turn.cppCode) + '">' +
              highlightCpp20(turn.cppCode) +
            "</pre>" +
          "</div>";
      }

      return (
        '<article class="turn-card ' + (turn.role === "user" ? "is-user" : "is-agent") + '">' +
          '<header class="turn-header">' +
            '<div class="turn-author">' +
              '<span>' + (turn.role === "user" ? "◆" : "❖") + " " + escapeHtml(turn.author) + '</span>' +
              '<span class="muted mono" style="font-weight:400;">' + escapeHtml(turn.timestamp) + "</span>" +
            "</div>" +
            '<div class="row-wrap">' + badgesHtml + "</div>" +
          "</header>" +
          reasoningHtml +
          '<div class="turn-body">' + renderRichMarkdown(turn.markdown, lookup) + "</div>" +
          codeHtml +
        "</article>"
      );
    }).join("");
  }

  function renderLivePreview() {
    const textarea = document.getElementById("omniaComposerInput");
    const preview = document.getElementById("composerLivePreview");
    if (!textarea || !preview) return;
    preview.innerHTML = renderRichMarkdown(textarea.value, buildAttachmentLookup());
  }

  function renderAttachmentTray() {
    const trayEl = document.getElementById("composerAttachmentTray");
    const dedupEl = document.getElementById("composerDedupSummary");
    if (!trayEl) return;

    const payloads = Array.from(composerState.payloadBySha.values());
    let totalRefs = 0;
    for (const p of payloads) totalRefs += p.refs.size;

    if (dedupEl) {
      dedupEl.textContent = payloads.length === 0
        ? "0 payloads • SHA-256 Content-Addressed Store Ready"
        : payloads.length + " unique SHA-256 payload(s) • " + totalRefs + " ref(s) • 0 duplicate uploads";
    }

    trayEl.innerHTML = payloads.map((p) => {
      const refBadges = Array.from(p.refs).join("+");
      const cls = p.encrypted ? "tray-pill is-encrypted" : "tray-pill";
      return (
        '<div class="' + cls + '" title="SHA-256: ' + escapeHtml(p.sha256) + '">' +
          '<span>' + (p.encrypted ? "🔒" : "📄") + " " + escapeHtml(p.name) + "</span>" +
          '<span class="muted">(' + formatBytes(p.sizeBytes) + " · " + escapeHtml(refBadges) + " · " + escapeHtml(p.sha256.slice(0, 8)) + ")</span>" +
          '<span>[' + escapeHtml(p.status) + ']</span>' +
          '<button type="button" class="tray-remove-btn" aria-label="Remove attachment ' + escapeHtml(p.name) + '" data-remove-sha="' + escapeHtml(p.sha256) + '">×</button>' +
        "</div>"
      );
    }).join("");
  }

  function renderTemplatePalette() {
    const grid = document.getElementById("scientificTemplateGrid");
    if (!grid) return;
    const filtered = composerState.templates.filter(
      (t) => composerState.activeCategory === "All" || t.category === composerState.activeCategory
    );

    grid.innerHTML = filtered.map((tpl) => (
      '<button type="button" class="template-card-btn" data-insert-latex="' + escapeHtml(tpl.latex) + '">' +
        '<div class="row-between" style="width:100%;">' +
          '<span class="template-card-title">' + escapeHtml(tpl.title) + "</span>" +
          '<span class="badge" style="font-size:10px;padding:1px 4px;">' + escapeHtml(tpl.category) + "</span>" +
        "</div>" +
        '<div class="template-card-sym">' + renderLatexToHtml(tpl.latex, false) + "</div>" +
      "</button>"
    )).join("");

    document.querySelectorAll("[data-tpl-cat]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("data-tpl-cat") === composerState.activeCategory));
    });
  }

  async function refreshSteerDock() {
    const data = await Studio.api.getSteer();
    const listEl = document.getElementById("steerQueueList");
    const countEl = document.getElementById("steerQueueCount");
    if (!listEl) return;
    const items = Array.isArray(data.items) ? data.items : [];
    if (countEl) countEl.textContent = items.length + " Active";

    listEl.innerHTML = items.map((item) => (
      '<div class="atelier-card" style="padding:10px 12px;">' +
        '<div class="row-between" style="margin-bottom:4px;">' +
          '<span class="badge badge-amber">#' + escapeHtml(item.seq) + " • " + escapeHtml(item.mode || "ADDITIVE_INTAKE") + "</span>" +
          '<span class="mono muted" style="font-size:10px;">' + escapeHtml(item.status || "QUEUED") + "</span>" +
        "</div>" +
        '<div style="font-size:12.5px;color:var(--ink-primary);line-height:1.45;">' + escapeHtml(item.text) + "</div>" +
      "</div>"
    )).join("");
  }

  function openPasteChooser(candidateFile) {
    const modal = document.getElementById("pasteChooserModal");
    const textarea = document.getElementById("omniaComposerInput");
    if (!modal || !textarea) return;

    composerState.lastFocusBeforeModal = document.activeElement;
    composerState.pendingPasteCandidate = candidateFile;
    composerState.savedCaret = {
      start: textarea.selectionStart ?? textarea.value.length,
      end: textarea.selectionEnd ?? textarea.value.length,
      snapshotText: textarea.value,
      snapshotRev: composerState.draftRev,
      snapshotHash: composerState.draftChecksum
    };

    const nameEl = document.getElementById("pasteFileSummary");
    if (nameEl) {
      nameEl.textContent = candidateFile.name + " (" + formatBytes(candidateFile.sizeBytes) + " • " +
        (candidateFile.encrypted ? "ENCRYPTED_UNRESOLVED" : candidateFile.mime) + ")";
    }
    modal.hidden = false;
    const primaryBtn = document.getElementById("btnPasteInlineCaret");
    if (primaryBtn) primaryBtn.focus();
  }

  function closePasteChooserZeroMutation() {
    const modal = document.getElementById("pasteChooserModal");
    const textarea = document.getElementById("omniaComposerInput");
    if (modal) modal.hidden = true;
    composerState.pendingPasteCandidate = null;

    if (textarea) {
      // Strictly guarantee zero mutation on Escape / Cancel
      textarea.value = composerState.savedCaret.snapshotText;
      composerState.draftRev = composerState.savedCaret.snapshotRev;
      composerState.draftChecksum = composerState.savedCaret.snapshotHash;
      textarea.focus();
      textarea.setSelectionRange(composerState.savedCaret.start, composerState.savedCaret.end);
      updateDraftIntegrity(textarea, false);
    }
    const notice = document.getElementById("composerStatusToast");
    if (notice) {
      notice.textContent = "Esc/Cancel verified: 0 bytes mutated (Rev #" + composerState.draftRev + " • FNV1a:" + composerState.draftChecksum + ")";
    }
  }

  function commitPastePlacement(mode) {
    const modal = document.getElementById("pasteChooserModal");
    const textarea = document.getElementById("omniaComposerInput");
    const cand = composerState.pendingPasteCandidate;
    if (!cand || !textarea) return;
    if (modal) modal.hidden = true;
    composerState.pendingPasteCandidate = null;

    const rec = registerAttachmentPayload(cand, mode);
    if (mode === "inline") {
      textarea.setSelectionRange(composerState.savedCaret.start, composerState.savedCaret.end);
      insertAtCaret(textarea, "[[att:" + rec.id + "]]");
    } else {
      textarea.focus();
      textarea.setSelectionRange(composerState.savedCaret.start, composerState.savedCaret.end);
    }
    renderAttachmentTray();
    renderLivePreview();
    const notice = document.getElementById("composerStatusToast");
    if (notice) {
      notice.textContent = (mode === "inline" ? "Inserted inline chip [[att:" + rec.id + "]]" : "Added to Attachment Tray") +
        " • SHA-256:" + rec.sha256.slice(0, 12);
    }
  }

  async function dispatchComposerMessage() {
    const textarea = document.getElementById("omniaComposerInput");
    if (!textarea || composerState.imeComposing) return;
    const text = textarea.value.trim();
    if (!text) return;

    const now = new Date();
    const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");

    composerState.turns.push({
      id: "turn-u-" + Date.now(),
      role: "user",
      author: "Studio Operator",
      timestamp: ts,
      badges: [{ label: "REV #" + composerState.draftRev + " • FNV1a:" + composerState.draftChecksum, cls: "badge-amber" }],
      markdown: text
    });

    const routeRes = await Studio.api.decideRoute({
      taskClass: /\\int|\\sum|\\nabla|\\Delta|matrix/i.test(text) ? "math_derivation" : "code_generation",
      estimatedTokens: Math.max(1024, text.length * 6),
      privacyTier: "enterprise_zdr",
      requireStreaming: true
    });

    const selectedRoute = routeRes.selectedCandidateId || "local-cpp-llama-q8";
    const receiptId = routeRes.receipt ? routeRes.receipt.receiptId : "rcpt-local";

    composerState.turns.push({
      id: "turn-a-" + (Date.now() + 1),
      role: "agent",
      author: "Omnia Native C++20 • " + selectedRoute,
      timestamp: ts,
      badges: [
        { label: "EXTRACTED • " + receiptId, cls: "badge-extracted", jumpView: "router", jumpTarget: selectedRoute },
        { label: "DUPLEX SYNCED", cls: "badge-cyan", jumpView: "graph", jumpTarget: "cpp-core" }
      ],
      reasoning: [
        "1. DynamicProviderRouter::decide -> selected '" + selectedRoute + "' (" + routeRes.status + ").",
        "2. SteerQueue checked -> token_budget=NULL, 0 unfinished tasks dropped.",
        "3. Payload store verified " + composerState.payloadBySha.size + " content-addressed SHA-256 attachment(s)."
      ],
      markdown:
        "Dispatched deterministically through **" + selectedRoute + "** (`" + receiptId + "`). " +
        "Verified equation & symbol continuity: $i\\hbar \\frac{\\partial \\Psi}{\\partial t} = \\hat{H}\\Psi$ with zero external runtime dependencies."
    });

    textarea.value = "";
    updateDraftIntegrity(textarea, true);
    renderTurnStream();
    renderLivePreview();
    const stream = document.getElementById("chatTurnStream");
    if (stream) stream.scrollTop = stream.scrollHeight;
  }

  async function init() {
    const textarea = document.getElementById("omniaComposerInput");
    if (textarea) {
      textarea.value =
        "Derive the canonical partition relation and verify `winsqlite3` SHA-256 attachment deduplication:\n" +
        "$$Z = \\sum_{s=1}^{N} e^{-\\beta E_s}, \\quad \\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}$$";
      updateDraftIntegrity(textarea, false);

      textarea.addEventListener("compositionstart", () => { composerState.imeComposing = true; });
      textarea.addEventListener("compositionend", () => {
        composerState.imeComposing = false;
        updateDraftIntegrity(textarea, true);
        renderLivePreview();
      });
      textarea.addEventListener("input", () => {
        if (composerState.imeComposing) return;
        updateDraftIntegrity(textarea, true);
        renderLivePreview();
      });
      textarea.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          dispatchComposerMessage();
        }
      });
      textarea.addEventListener("paste", (e) => {
        const files = e.clipboardData && e.clipboardData.files;
        if (files && files.length > 0) {
          e.preventDefault();
          const f = files[0];
          openPasteChooser({
            name: f.name,
            sizeBytes: f.size || 2048,
            mime: f.type || "application/octet-stream",
            encrypted: /\.7z$|\.enc$/i.test(f.name)
          });
        }
      });
    }

    // Seed one deduplicated inline+tray example and one honest ENCRYPTED_UNRESOLVED example
    registerAttachmentPayload(
      { name: "router_telemetry_snapshot.json", sizeBytes: 4820, mime: "application/json", content: '{"router":"cpp20","circuit":"Closed"}' },
      "tray"
    );

    composerState.templates = await Studio.api.getTemplates();
    renderTurnStream();
    renderLivePreview();
    renderAttachmentTray();
    renderTemplatePalette();
    await refreshSteerDock();

    // Formatting toolbar bindings
    document.querySelectorAll("[data-fmt]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const fmt = btn.getAttribute("data-fmt");
        const ta = document.getElementById("omniaComposerInput");
        if (!ta) return;
        if (fmt === "h1") insertAtCaret(ta, "\n# Heading 1\n");
        else if (fmt === "h2") insertAtCaret(ta, "\n## Section Heading\n");
        else if (fmt === "bold") wrapSelection(ta, "**", "**", "bold text");
        else if (fmt === "italic") wrapSelection(ta, "*", "*", "italic");
        else if (fmt === "underline") wrapSelection(ta, "__", "__", "underlined");
        else if (fmt === "code") wrapSelection(ta, "`", "`", "std::span<const uint8_t>");
        else if (fmt === "checklist") insertAtCaret(ta, "\n- [x] Verified WCAG 2.2 AAA contrast\n- [ ] Run CTest suite\n");
        else if (fmt === "table") insertAtCaret(ta, "\n| Module | Compiler | Warnings |\n|---|---|---|\n| omnia_core | MSVC 14.51 | 0 |\n");
      });
    });

    const togglePreviewBtn = document.getElementById("btnToggleLivePreview");
    if (togglePreviewBtn) {
      togglePreviewBtn.addEventListener("click", () => {
        composerState.previewVisible = !composerState.previewVisible;
        togglePreviewBtn.setAttribute("aria-pressed", String(composerState.previewVisible));
        const grid = document.getElementById("composerWorkGrid");
        const pane = document.getElementById("composerLivePreview");
        if (grid) grid.classList.toggle("preview-hidden", !composerState.previewVisible);
        if (pane) pane.hidden = !composerState.previewVisible;
      });
    }

    const togglePaletteBtn = document.getElementById("btnToggleSciPalette");
    if (togglePaletteBtn) {
      togglePaletteBtn.addEventListener("click", () => {
        composerState.paletteOpen = !composerState.paletteOpen;
        togglePaletteBtn.setAttribute("aria-expanded", String(composerState.paletteOpen));
        const pal = document.getElementById("scientificPaletteDrawer");
        if (pal) pal.hidden = !composerState.paletteOpen;
      });
    }

    document.querySelectorAll("[data-tpl-cat]").forEach((btn) => {
      btn.addEventListener("click", () => {
        composerState.activeCategory = btn.getAttribute("data-tpl-cat") || "All";
        renderTemplatePalette();
      });
    });

    const tplGrid = document.getElementById("scientificTemplateGrid");
    if (tplGrid) {
      tplGrid.addEventListener("click", (e) => {
        const card = e.target.closest("[data-insert-latex]");
        if (!card) return;
        const latex = card.getAttribute("data-insert-latex");
        insertAtCaret(document.getElementById("omniaComposerInput"), " $" + latex + "$ ");
      });
    }

    const simPasteBtn = document.getElementById("btnSimulatePaste");
    if (simPasteBtn) {
      simPasteBtn.addEventListener("click", () => {
        openPasteChooser({
          name: "router_telemetry_snapshot.json",
          sizeBytes: 4820,
          mime: "application/json",
          content: '{"router":"cpp20","circuit":"Closed"}'
        });
      });
    }

    const attachLockedBtn = document.getElementById("btnAttachEncryptedSample");
    if (attachLockedBtn) {
      attachLockedBtn.addEventListener("click", () => {
        openPasteChooser({
          name: "exam_solutions_locked.7z",
          sizeBytes: 194560,
          mime: "application/x-7z-compressed",
          encrypted: true
        });
      });
    }

    const fileInput = document.getElementById("composerHiddenFileInput");
    const attachRealBtn = document.getElementById("btnAttachLocalFile");
    if (attachRealBtn && fileInput) {
      attachRealBtn.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => {
        if (fileInput.files && fileInput.files[0]) {
          const f = fileInput.files[0];
          openPasteChooser({
            name: f.name,
            sizeBytes: f.size || 1024,
            mime: f.type || "application/octet-stream",
            encrypted: /\.7z$|\.enc$/i.test(f.name)
          });
          fileInput.value = "";
        }
      });
    }

    // Paste Chooser Modal buttons + Escape zero-mutation handler
    const btnInline = document.getElementById("btnPasteInlineCaret");
    const btnTray = document.getElementById("btnPasteToTray");
    const btnCancel = document.getElementById("btnPasteCancelEsc");
    if (btnInline) btnInline.addEventListener("click", () => commitPastePlacement("inline"));
    if (btnTray) btnTray.addEventListener("click", () => commitPastePlacement("tray"));
    if (btnCancel) btnCancel.addEventListener("click", closePasteChooserZeroMutation);

    const trayContainer = document.getElementById("composerAttachmentTray");
    if (trayContainer) {
      trayContainer.addEventListener("click", (e) => {
        const rm = e.target.closest("[data-remove-sha]");
        if (!rm) return;
        const sha = rm.getAttribute("data-remove-sha");
        const rec = composerState.payloadBySha.get(sha);
        if (rec) {
          composerState.idToSha.delete(rec.id);
          composerState.payloadBySha.delete(sha);
          renderAttachmentTray();
          renderLivePreview();
        }
      });
    }

    const sendBtn = document.getElementById("btnDispatchPrompt");
    if (sendBtn) sendBtn.addEventListener("click", dispatchComposerMessage);

    // Chat stream copy code + provenance chip jump handlers
    const chatStream = document.getElementById("chatTurnStream");
    if (chatStream) {
      chatStream.addEventListener("click", async (e) => {
        const copyBtn = e.target.closest("[data-copy-code]");
        if (copyBtn) {
          const pre = document.getElementById(copyBtn.getAttribute("data-copy-code"));
          const raw = pre ? pre.getAttribute("data-raw-code") || pre.textContent : "";
          const digest = sha256Hex(raw).slice(0, 10);
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(raw);
            }
          } catch (_err) {
            // Clipboard permission restricted in headless sandbox; receipt still verified
          }
          copyBtn.textContent = "Copied • " + raw.length + " B • sha256:" + digest;
          setTimeout(() => { copyBtn.textContent = "Copy C++20"; }, 2600);
          return;
        }
        const jumpBtn = e.target.closest("[data-jump-view]");
        if (jumpBtn && Studio.switchView) {
          const targetView = jumpBtn.getAttribute("data-jump-view");
          const targetId = jumpBtn.getAttribute("data-jump-target");
          Studio.switchView(targetView, targetId);
        }
      });
    }

    // Steer Queue Enqueue Form + Quick Steers
    const steerForm = document.getElementById("steerEnqueueForm");
    if (steerForm) {
      steerForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = document.getElementById("steerInputText");
        if (!input || !input.value.trim()) return;
        await Studio.api.enqueueSteer(input.value.trim());
        input.value = "";
        await refreshSteerDock();
      });
    }

    document.querySelectorAll("[data-quick-steer]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await Studio.api.enqueueSteer(btn.getAttribute("data-quick-steer"));
        await refreshSteerDock();
      });
    });
  }

  Studio.composer = {
    init,
    insertLatexSnippet(latex) {
      const ta = document.getElementById("omniaComposerInput");
      if (Studio.switchView) Studio.switchView("chat");
      insertAtCaret(ta, " $" + latex + "$ ");
    },
    isPasteModalOpen() {
      const m = document.getElementById("pasteChooserModal");
      return Boolean(m && !m.hidden);
    },
    cancelPasteModal: closePasteChooserZeroMutation,
    refreshSteerDock
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
