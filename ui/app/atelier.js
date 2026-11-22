"use strict";

(function initAtelierStudioModule(global) {
  const Studio = (global.OmniaStudio = global.OmniaStudio || {});
  const { escapeHtml, formatBytes, highlightCode } = Studio.utils;

  const ARTIFACT_KINDS = [
    "briefing",
    "study_guide",
    "faq",
    "timeline",
    "quiz",
    "flashcards",
    "mind_map",
    "infographic_spec",
    "data_table"
  ];

  const ARTIFACT_LABELS = {
    briefing: "Briefing",
    study_guide: "Study Guide",
    faq: "FAQ",
    timeline: "Timeline",
    quiz: "Quiz",
    flashcards: "Flashcards",
    mind_map: "Mind Map",
    infographic_spec: "Infographic",
    data_table: "Data Table"
  };

  const state = {
    viewMode: "notebook",
    status: null,
    statusError: null,
    notebooks: [],
    activeNotebookId: null,
    sources: [],
    highlightedSourceId: null,
    turns: [],
    verificationByTurnId: new Map(),
    latestPack: null,
    evidenceByMarker: new Map(),
    artifacts: [],
    selectedArtifactId: null,
    selectedArtifactKind: "briefing",
    btwThreads: [],
    activeBtwId: null,
    btwDrawerOpen: false,
    btwAppendRole: "user",
    stagedBtwQuote: null,
    pendingQuoteCards: [],
    activeSelection: null,
    bridgeEvents: [],
    selectedModelId: "gemini-3.5-flash-lite",
    selectedEffort: "medium"
  };

  function getActiveNotebook() {
    if (!state.activeNotebookId) return null;
    return state.notebooks.find((n) => n.notebook_id === state.activeNotebookId) || null;
  }

  function showBanner(elId, kind, title, detail) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!title && !detail) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.className = kind === "error"
      ? "studio-error-banner"
      : kind === "success"
        ? "studio-success-banner"
        : "studio-info-banner";
    el.hidden = false;
    el.innerHTML =
      (kind === "error"
        ? '<span class="studio-error-code">' + escapeHtml(title) + "</span>"
        : '<strong class="mono" style="font-size:11px;">' + escapeHtml(title) + "</strong> ") +
      "<span>" + escapeHtml(detail || "") + "</span>";
  }

  function formatInlineWithCitations(rawText) {
    const escaped = escapeHtml(rawText);
    return escaped
      .replace(/`([^`]+)`/g, '<code class="mono">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^A-Za-z0-9_])_([^_]+)_(?=$|[^A-Za-z0-9_])/g, "$1<em>$2</em>")
      .replace(/\[([A-Za-z0-9_-]+):(\d+)\]/g, (match, srcId, chunkIdx) => (
        '<button type="button" class="at-cite-chip" data-cite-marker="' +
          escapeHtml("[" + srcId + ":" + chunkIdx + "]") +
          '" data-cite-source-id="' + escapeHtml(srcId) +
          '" data-cite-chunk-idx="' + escapeHtml(chunkIdx) +
          '" aria-label="Inspect citation ' + escapeHtml(srcId) + " chunk " + escapeHtml(chunkIdx) + '">' +
          escapeHtml("[" + srcId + ":" + chunkIdx + "]") +
        "</button>"
      ));
  }

  function renderAtelierMarkdown(markdown) {
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let inCode = false;
    let codeLang = "";
    let codeLines = [];
    let tableRows = [];

    function flushTable() {
      if (!tableRows.length) return;
      const rows = tableRows.slice();
      tableRows = [];
      const parseCells = (line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const headCells = parseCells(rows[0]);
      let bodyStart = 1;
      if (rows.length > 1 && /^[\s|:-]+$/.test(rows[1])) {
        bodyStart = 2;
      }
      const bodyRows = rows.slice(bodyStart).map(parseCells);
      out.push(
        '<div class="at-md-table-wrap"><table class="at-md-table"><thead><tr>' +
          headCells.map((c) => "<th>" + formatInlineWithCitations(c) + "</th>").join("") +
        "</tr></thead><tbody>" +
          bodyRows.map((r) => "<tr>" + r.map((c) => "<td>" + formatInlineWithCitations(c) + "</td>").join("") + "</tr>").join("") +
        "</tbody></table></div>"
      );
    }

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();

      if (trimmed.startsWith("```")) {
        flushTable();
        if (!inCode) {
          inCode = true;
          codeLang = trimmed.slice(3).trim();
          codeLines = [];
        } else {
          inCode = false;
          const bodyHtml = codeLang === "rust" || codeLang === "rs"
            ? highlightCode(codeLines.join("\n"))
            : escapeHtml(codeLines.join("\n"));
          out.push(
            '<div class="code-frame" style="margin:6px 0;">' +
              (codeLang ? '<div class="code-frame-bar"><span>' + escapeHtml(codeLang) + "</span></div>" : "") +
              '<pre class="code-pre">' + bodyHtml + "</pre>" +
            "</div>"
          );
          codeLang = "";
          codeLines = [];
        }
        continue;
      }

      if (inCode) {
        codeLines.push(raw);
        continue;
      }

      if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2) {
        tableRows.push(trimmed);
        continue;
      }
      flushTable();

      if (!trimmed) continue;

      if (trimmed.startsWith("### ")) {
        out.push('<div class="at-md-h3">' + formatInlineWithCitations(trimmed.slice(4)) + "</div>");
      } else if (trimmed.startsWith("## ")) {
        out.push('<div class="at-md-h2">' + formatInlineWithCitations(trimmed.slice(3)) + "</div>");
      } else if (trimmed.startsWith("# ")) {
        out.push('<div class="at-md-h1">' + formatInlineWithCitations(trimmed.slice(2)) + "</div>");
      } else if (trimmed.startsWith("> ")) {
        out.push('<blockquote class="at-md-blockquote">' + formatInlineWithCitations(trimmed.slice(2)) + "</blockquote>");
      } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        out.push('<div class="at-md-list-item">• ' + formatInlineWithCitations(trimmed.slice(2)) + "</div>");
      } else {
        out.push("<p>" + formatInlineWithCitations(raw) + "</p>");
      }
    }

    flushTable();
    if (inCode && codeLines.length) {
      out.push('<pre class="code-pre">' + escapeHtml(codeLines.join("\n")) + "</pre>");
    }
    return out.join("") || '<span class="muted">Empty content.</span>';
  }

  function bindRadiogroupKeyboard(groupEl, selector, onSelect) {
    if (!groupEl) return;
    groupEl.addEventListener("keydown", (e) => {
      const items = Array.from(groupEl.querySelectorAll(selector));
      if (!items.length) return;
      const idx = items.indexOf(document.activeElement);
      if (idx < 0) return;
      let nextIdx = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        nextIdx = (idx + 1) % items.length;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        nextIdx = (idx - 1 + items.length) % items.length;
      } else if (e.key === "Home") {
        nextIdx = 0;
      } else if (e.key === "End") {
        nextIdx = items.length - 1;
      }
      if (nextIdx >= 0) {
        e.preventDefault();
        items[nextIdx].focus();
        onSelect(items[nextIdx]);
      }
    });
  }

  function setViewMode(mode) {
    const valid = mode === "gemini" || mode === "split" ? mode : "notebook";
    state.viewMode = valid;
    const section = document.getElementById("view-atelier");
    if (section) section.setAttribute("data-atelier-mode", valid);
    const group = document.getElementById("atViewModeGroup");
    if (group) {
      group.querySelectorAll("[data-at-mode]").forEach((btn) => {
        const active = btn.getAttribute("data-at-mode") === valid;
        btn.setAttribute("aria-checked", String(active));
        btn.tabIndex = active ? 0 : -1;
      });
    }
  }

  function syncModelEffortUi() {
    const active = getActiveNotebook();
    if (active) {
      state.selectedModelId = active.model_id || state.selectedModelId;
      state.selectedEffort = active.effort_level || state.selectedEffort;
    }
    const summaryEl = document.getElementById("atModelSummaryLabel");
    if (summaryEl) {
      summaryEl.textContent = state.selectedModelId + " · " + state.selectedEffort;
    }
    const modelGroup = document.getElementById("atModelGroup");
    if (modelGroup) {
      modelGroup.querySelectorAll("[data-at-model]").forEach((btn) => {
        const checked = btn.getAttribute("data-at-model") === state.selectedModelId;
        btn.setAttribute("aria-checked", String(checked));
        btn.tabIndex = checked ? 0 : -1;
      });
    }
    const effortGroup = document.getElementById("atEffortGroup");
    if (effortGroup) {
      effortGroup.querySelectorAll("[data-at-effort]").forEach((btn) => {
        const checked = btn.getAttribute("data-at-effort") === state.selectedEffort;
        btn.setAttribute("aria-checked", String(checked));
        btn.tabIndex = checked ? 0 : -1;
      });
    }
  }

  function syncArtifactKindUi() {
    const group = document.getElementById("atArtifactKindGroup");
    if (!group) return;
    group.querySelectorAll("[data-at-kind]").forEach((btn) => {
      const checked = btn.getAttribute("data-at-kind") === state.selectedArtifactKind;
      btn.setAttribute("aria-checked", String(checked));
      btn.tabIndex = checked ? 0 : -1;
    });
  }

  function syncBtwRoleUi() {
    const group = document.getElementById("atBtwRoleGroup");
    if (!group) return;
    group.querySelectorAll("[data-at-btw-role]").forEach((btn) => {
      const checked = btn.getAttribute("data-at-btw-role") === state.btwAppendRole;
      btn.setAttribute("aria-checked", String(checked));
      btn.tabIndex = checked ? 0 : -1;
    });
  }

  function renderStatus() {
    const badge = document.getElementById("atStatusBadge");
    if (!badge) return;
    if (state.statusError) {
      badge.className = "badge badge-coral";
      badge.textContent = "ENGINE UNAVAILABLE";
      badge.title = state.statusError.code + ": " + state.statusError.message;
      return;
    }
    if (!state.status) {
      badge.className = "badge badge-cyan";
      badge.textContent = "Engine probing…";
      return;
    }
    const st = state.status;
    badge.className = "badge badge-emerald";
    badge.textContent = (st.journal_mode || "wal").toUpperCase() +
      (st.fts5_enabled ? " · FTS5" : " · BM25") +
      " · " + String(st.notebook_count ?? state.notebooks.length) + " nb";
    badge.title = "omnia-notebook status: " + (st.db_path || "active");
  }

  function renderNotebooks() {
    const listEl = document.getElementById("atNotebookList");
    const countEl = document.getElementById("atNotebookCountBadge");
    const activeTitleEl = document.getElementById("atActiveNotebookBadge");
    if (countEl) countEl.textContent = String(state.notebooks.length);

    const active = getActiveNotebook();
    if (activeTitleEl) {
      activeTitleEl.textContent = active ? active.title : "No notebook selected";
    }
    syncModelEffortUi();

    if (!listEl) return;
    if (state.notebooks.length === 0) {
      listEl.innerHTML = '<div class="muted mono" style="font-size:11px;">No notebooks yet. Create a notebook above to begin.</div>';
      return;
    }

    listEl.innerHTML = state.notebooks.map((nb) => {
      const isActive = nb.notebook_id === state.activeNotebookId;
      return (
        '<div class="at-notebook-item ' + (isActive ? "is-active" : "") + '" role="option" aria-selected="' + String(isActive) + '">' +
          '<button type="button" class="at-notebook-select-btn" data-at-select-nb="' + escapeHtml(nb.notebook_id) + '">' +
            '<span style="font-size:12px;font-weight:600;" class="truncate">' + escapeHtml(nb.title) + "</span>" +
            '<span class="mono muted" style="font-size:10px;">' +
              escapeHtml((nb.model_id || "default") + " · " + (nb.effort_level || "medium")) +
            "</span>" +
          "</button>" +
          '<button type="button" class="btn btn-danger btn-xs" data-at-delete-nb="' + escapeHtml(nb.notebook_id) +
            '" aria-label="Delete notebook ' + escapeHtml(nb.title) + '">Del</button>' +
        "</div>"
      );
    }).join("");
  }

  function renderSources() {
    const listEl = document.getElementById("atSourceList");
    const countEl = document.getElementById("atSourceCountBadge");
    if (countEl) countEl.textContent = String(state.sources.length);
    if (!listEl) return;

    if (!state.activeNotebookId) {
      listEl.innerHTML = '<div class="muted mono" style="font-size:11px;">Select or create a notebook to inspect sources.</div>';
      return;
    }
    if (state.sources.length === 0) {
      listEl.innerHTML = '<div class="muted mono" style="font-size:11px;">0 sources ingested in this notebook.</div>';
      return;
    }

    listEl.innerHTML = state.sources.map((src) => {
      const highlighted = state.highlightedSourceId === src.source_id;
      return (
        '<article class="at-source-item ' + (highlighted ? "is-highlighted" : "") + '" data-source-id="' + escapeHtml(src.source_id) + '">' +
          '<div class="row-between">' +
            '<strong style="font-size:11.5px;" class="truncate" title="' + escapeHtml(src.title) + '">' + escapeHtml(src.title) + "</strong>" +
            '<span class="badge badge-cyan">' + escapeHtml(src.source_kind || "document") + "</span>" +
          "</div>" +
          '<div class="mono muted" style="font-size:10px;overflow-wrap:anywhere;">' +
            escapeHtml(src.source_id) + " · " + escapeHtml(src.safe_filename || "") +
          "</div>" +
          '<div class="row-between mono muted" style="font-size:10px;">' +
            "<span>" + escapeHtml(String(src.chunk_count || 0)) + " chunks · " + escapeHtml(formatBytes(src.byte_size || 0)) + "</span>" +
            '<span title="' + escapeHtml(src.content_sha256 || "") + '">sha256:' + escapeHtml((src.content_sha256 || "").slice(0, 10)) + "</span>" +
          "</div>" +
        "</article>"
      );
    }).join("");
  }

  function renderEvidencePack() {
    const section = document.getElementById("atEvidenceSection");
    const metaEl = document.getElementById("atEvidenceMeta");
    const listEl = document.getElementById("atEvidenceList");
    if (!section || !listEl) return;

    const pack = state.latestPack;
    if (!pack || pack.notebook_id !== state.activeNotebookId) {
      section.hidden = true;
      listEl.innerHTML = "";
      return;
    }

    section.hidden = false;
    const evidence = Array.isArray(pack.evidence) ? pack.evidence : [];
    if (metaEl) {
      metaEl.textContent = evidence.length + " chunks · lang=" + (pack.language || "en") +
        " · graphify=" + String(pack.graphify_entity_count || 0) +
        " · mem=" + String(Array.isArray(pack.memory_links) ? pack.memory_links.length : 0);
    }

    if (evidence.length === 0) {
      listEl.innerHTML = '<div class="atelier-card muted mono" style="font-size:11px;">No chunks matched "' + escapeHtml(pack.query || "") + '".</div>';
      return;
    }

    listEl.innerHTML = evidence.map((ev) => {
      const marker = ev.citation_marker || ("[" + ev.source_id + ":" + ev.chunk_idx + "]");
      const score = Number.isFinite(Number(ev.hybrid_score)) ? Number(ev.hybrid_score).toFixed(3) : "—";
      const terms = Array.isArray(ev.matched_terms) && ev.matched_terms.length
        ? " · terms: " + ev.matched_terms.join(", ")
        : "";
      return (
        '<article class="at-evidence-card">' +
          '<div class="row-between">' +
            '<div class="row-wrap" style="gap:5px;">' +
              '<button type="button" class="at-cite-chip" data-cite-marker="' + escapeHtml(marker) +
                '" data-cite-source-id="' + escapeHtml(ev.source_id) +
                '" data-cite-chunk-idx="' + escapeHtml(String(ev.chunk_idx)) + '">' + escapeHtml(marker) + "</button>" +
              '<strong style="font-size:11.5px;">' + escapeHtml(ev.source_title || ev.source_id) + "</strong>" +
            "</div>" +
            '<div class="row-wrap" style="gap:4px;">' +
              '<span class="badge badge-emerald">score ' + escapeHtml(score) + "</span>" +
              '<span class="badge">' + escapeHtml(ev.provenance || "extracted") + "</span>" +
            "</div>" +
          "</div>" +
          (ev.heading ? '<div class="mono muted" style="font-size:10.5px;">Heading: ' + escapeHtml(ev.heading) + "</div>" : "") +
          '<div style="font-size:12px;color:var(--ink-secondary);line-height:1.45;">' + escapeHtml(ev.excerpt || "") + "</div>" +
          '<div class="mono muted" style="font-size:10px;">bm25f=' +
            escapeHtml(Number(ev.bm25f_score || 0).toFixed(2)) +
            " · rag_bps=" + escapeHtml(String(ev.rag_relevance_bps || 0)) +
            escapeHtml(terms) +
          "</div>" +
        "</article>"
      );
    }).join("");
  }

  function renderQuoteChips() {
    const html = state.pendingQuoteCards.map((card, idx) => (
      '<span class="at-quote-chip">' +
        '<span class="truncate" style="max-width:240px;" title="' + escapeHtml(card.markdown_blockquote || card.quote.excerpt) + '">' +
          escapeHtml(card.composer_chip_label || card.badge_label || "Quote") +
        "</span>" +
        '<button type="button" class="tray-remove-btn" data-at-remove-quote="' + idx + '" aria-label="Remove attached quote">×</button>' +
      "</span>"
    )).join("");
    const nbBar = document.getElementById("atNotebookQuoteChips");
    const gmBar = document.getElementById("atGeminiQuoteChips");
    if (nbBar) nbBar.innerHTML = html;
    if (gmBar) gmBar.innerHTML = html;
  }

  function renderTurns() {
    const nbList = document.getElementById("atNotebookTurnsList");
    const gmList = document.getElementById("atGeminiTurnsList");
    const statsEl = document.getElementById("atGroundedStatsBadge");

    const nbTurns = state.turns.filter((t) => String(t.surface || "notebook").toLowerCase() !== "gemini");
    const gmTurns = state.turns.filter((t) => String(t.surface || "").toLowerCase() === "gemini");

    if (statsEl) statsEl.textContent = nbTurns.length + " notebook turns";

    function renderTurnCard(turn, surface) {
      const ver = state.verificationByTurnId.get(turn.turn_id) || null;
      const verBadge = ver
        ? (ver.valid
          ? '<span class="badge badge-emerald">Citations Verified (' + ver.verified_citations.length + ")</span>"
          : '<span class="badge badge-coral">Citations Invalid (' + ver.invalid_citations.length + ")</span>")
        : "";
      const citations = Array.isArray(turn.citations) ? turn.citations : [];
      const quotes = Array.isArray(turn.quotes) ? turn.quotes : [];
      const bridgeBtn = surface === "notebook"
        ? '<button type="button" class="btn btn-subtle btn-xs" data-at-bridge-turn="' + escapeHtml(turn.turn_id) + '" data-at-bridge-dir="notebook_to_gemini">Send to Gemini</button>'
        : '<button type="button" class="btn btn-subtle btn-xs" data-at-bridge-turn="' + escapeHtml(turn.turn_id) + '" data-at-bridge-dir="gemini_to_notebook">Bridge to Notebook</button>';

      return (
        '<article class="turn-card ' + (surface === "gemini" ? "is-user" : "is-agent") + '" data-turn-card-id="' + escapeHtml(turn.turn_id) + '">' +
          '<div class="turn-header">' +
            '<div class="row-wrap">' +
              '<span class="badge ' + (surface === "gemini" ? "badge-amber" : "badge-cyan") + '">#' + escapeHtml(String(turn.turn_index ?? 0)) + " · " + escapeHtml(surface) + "</span>" +
              '<span class="mono muted" style="font-size:10.5px;">' + escapeHtml((turn.model_id || "") + " · " + (turn.effort_level || "")) + "</span>" +
              verBadge +
            "</div>" +
            '<div class="row-wrap" style="gap:4px;">' +
              '<button type="button" class="btn btn-subtle btn-xs" data-at-kbd-select-turn="' + escapeHtml(turn.turn_id) + '" data-at-kbd-surface="' + escapeHtml(surface) + '">Quote / BTW</button>' +
              (surface === "notebook"
                ? '<button type="button" class="btn btn-subtle btn-xs" data-at-verify-turn="' + escapeHtml(turn.turn_id) + '">Verify Citations</button>'
                : "") +
              bridgeBtn +
            "</div>" +
          "</div>" +
          '<div class="atelier-card-elevated" style="padding:6px 10px;">' +
            '<div class="mono muted" style="font-size:10px;margin-bottom:2px;">PROMPT</div>' +
            '<div style="font-size:12.5px;font-weight:600;">' + escapeHtml(turn.prompt_text || "") + "</div>" +
          "</div>" +
          (quotes.length
            ? '<div class="row-wrap" style="gap:4px;">' + quotes.map((q) =>
                '<span class="badge badge-amber" title="' + escapeHtml((q && q.excerpt) || "") + '">Quoted: ' + escapeHtml(((q && q.excerpt) || "").slice(0, 42)) + "</span>"
              ).join("") + "</div>"
            : "") +
          '<div class="at-turn-selectable" data-turn-id="' + escapeHtml(turn.turn_id) + '" data-turn-surface="' + escapeHtml(surface) + '">' +
            renderAtelierMarkdown(turn.response_markdown || "") +
          "</div>" +
          (citations.length
            ? '<div class="row-wrap" style="gap:4px;border-top:1px solid var(--border-subtle);padding-top:6px;">' +
                '<span class="mono muted" style="font-size:10px;">Citations:</span>' +
                citations.map((c) => {
                  const m = /^\[([A-Za-z0-9_-]+):(\d+)\]$/.exec(String(c || "").trim());
                  if (!m) return '<span class="badge">' + escapeHtml(c) + "</span>";
                  return '<button type="button" class="at-cite-chip" data-cite-marker="' + escapeHtml(c) +
                    '" data-cite-source-id="' + escapeHtml(m[1]) +
                    '" data-cite-chunk-idx="' + escapeHtml(m[2]) + '">' + escapeHtml(c) + "</button>";
                }).join("") +
              "</div>"
            : "") +
        "</article>"
      );
    }

    if (nbList) {
      nbList.innerHTML = nbTurns.length
        ? nbTurns.map((t) => renderTurnCard(t, "notebook")).join("")
        : '<div class="atelier-card muted" style="font-size:12px;">' +
            (state.activeNotebookId
              ? "No grounded notebook turns recorded yet. Ask a grounded question below to retrieve evidence and record a turn. Highlight any turn text to invoke Quote or BTW."
              : "Create or select a notebook on the left to start grounded research.") +
          "</div>";
    }

    if (gmList) {
      gmList.innerHTML = gmTurns.length
        ? gmTurns.map((t) => renderTurnCard(t, "gemini")).join("")
        : '<div class="atelier-card muted" style="font-size:12px;">No Gemini surface turns recorded for this notebook yet.</div>';
    }
  }

  function renderBridgeEvents() {
    const countBadge = document.getElementById("atBridgeCountBadge");
    const summaryEl = document.getElementById("atBridgeSummaryMeta");
    const listEl = document.getElementById("atBridgeEventsList");
    const n = state.bridgeEvents.length;
    if (countBadge) countBadge.textContent = n + " bridge events";
    if (summaryEl) summaryEl.textContent = n + " events";
    if (!listEl) return;

    if (n === 0) {
      listEl.innerHTML = '<div class="muted mono" style="font-size:11px;">No Cross-Bridge events recorded.</div>';
      return;
    }

    listEl.innerHTML = state.bridgeEvents.map((ev) => (
      '<div class="at-bridge-row">' +
        '<div class="row-between">' +
          '<span class="badge ' + (ev.direction === "gemini_to_notebook" ? "badge-emerald" : "badge-amber") + '">' +
            escapeHtml(ev.direction || "bridge") +
          "</span>" +
          '<span class="mono muted">' + escapeHtml((ev.event_id || "").slice(0, 14)) + "</span>" +
        "</div>" +
        (ev.target_source_id
          ? '<div class="mono muted">Created source: ' + escapeHtml(ev.target_source_id) + "</div>"
          : "") +
      "</div>"
    )).join("");
  }

  function renderArtifacts() {
    const listEl = document.getElementById("atArtifactList");
    const countEl = document.getElementById("atArtifactsCountBadge");
    if (countEl) countEl.textContent = String(state.artifacts.length);
    if (!listEl) return;

    if (!state.activeNotebookId) {
      listEl.innerHTML = '<div class="muted mono" style="font-size:11px;">Select or create a notebook to generate artifacts.</div>';
      renderArtifactViewer();
      return;
    }

    if (state.artifacts.length === 0) {
      listEl.innerHTML = '<div class="muted mono" style="font-size:11px;">No Studio artifacts generated yet. Pick one of the 9 kinds above and click Generate Artifact.</div>';
      renderArtifactViewer();
      return;
    }

    listEl.innerHTML = state.artifacts.map((art) => {
      const isActive = art.artifact_id === state.selectedArtifactId;
      const kindLabel = ARTIFACT_LABELS[art.kind] || art.kind;
      return (
        '<article class="at-artifact-card ' + (isActive ? "is-active" : "") + '">' +
          '<div class="row-between">' +
            '<span class="badge badge-cyan">' + escapeHtml(kindLabel) + "</span>" +
            '<div class="row-wrap" style="gap:4px;">' +
              '<button type="button" class="btn btn-subtle btn-xs" data-at-open-artifact="' + escapeHtml(art.artifact_id) + '">View</button>' +
              '<button type="button" class="btn btn-danger btn-xs" data-at-delete-artifact="' + escapeHtml(art.artifact_id) + '">Del</button>' +
            "</div>" +
          "</div>" +
          '<strong style="font-size:12px;">' + escapeHtml(art.title || kindLabel) + "</strong>" +
          '<div class="mono muted" style="font-size:10px;">' +
            escapeHtml(String((art.cited_source_ids || []).length)) + " cited sources · " +
            escapeHtml((art.artifact_id || "").slice(0, 14)) +
          "</div>" +
        "</article>"
      );
    }).join("");

    renderArtifactViewer();
  }

  function renderArtifactViewer() {
    const card = document.getElementById("atArtifactViewerCard");
    if (!card) return;
    const art = state.artifacts.find((a) => a.artifact_id === state.selectedArtifactId) || null;
    if (!art) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const kindEl = document.getElementById("atArtifactViewerKind");
    const renameInput = document.getElementById("atArtifactRenameInput");
    const bodyEl = document.getElementById("atArtifactViewerBody");
    const jsonEl = document.getElementById("atArtifactViewerJson");
    if (kindEl) kindEl.textContent = ARTIFACT_LABELS[art.kind] || art.kind;
    if (renameInput) renameInput.value = art.title || "";
    if (bodyEl) bodyEl.innerHTML = renderAtelierMarkdown(art.content_markdown || "");
    if (jsonEl) jsonEl.textContent = JSON.stringify(art.structured_json || {}, null, 2);
  }

  function setBtwDrawerOpen(open) {
    state.btwDrawerOpen = Boolean(open);
    const drawer = document.getElementById("atBtwDrawer");
    const toggleBtn = document.getElementById("btnAtToggleBtwDrawer");
    if (drawer) drawer.hidden = !state.btwDrawerOpen;
    if (toggleBtn) toggleBtn.setAttribute("aria-expanded", String(state.btwDrawerOpen));
  }

  function renderBtwDrawer() {
    const countBadge = document.getElementById("atBtwCountBadge");
    if (countBadge) countBadge.textContent = String(state.btwThreads.length);

    const createCard = document.getElementById("atBtwCreateCard");
    const stagedEl = document.getElementById("atBtwStagedQuote");
    if (createCard && stagedEl) {
      if (state.stagedBtwQuote) {
        createCard.hidden = false;
        stagedEl.textContent = '"' + state.stagedBtwQuote.excerpt + '" (' +
          state.stagedBtwQuote.surface + " · chars " +
          state.stagedBtwQuote.char_start + ".." + state.stagedBtwQuote.char_end + ")";
      } else {
        createCard.hidden = true;
        stagedEl.textContent = "";
      }
    }

    const listEl = document.getElementById("atBtwThreadList");
    if (listEl) {
      if (state.btwThreads.length === 0) {
        listEl.innerHTML = '<div class="muted mono" style="font-size:11px;">No BTW threads in this notebook yet.</div>';
      } else {
        listEl.innerHTML = state.btwThreads.map((th) => {
          const active = th.btw_id === state.activeBtwId;
          const excerpt = (th.anchor_quote && th.anchor_quote.excerpt) || "(no excerpt)";
          const msgCount = Array.isArray(th.messages) ? th.messages.length : 0;
          const statusCls = th.status === "promoted" ? "badge-emerald" : th.status === "closed" ? "badge-coral" : "badge-cyan";
          return (
            '<button type="button" class="at-btw-thread-btn ' + (active ? "is-active" : "") + '" data-at-select-btw="' + escapeHtml(th.btw_id) + '">' +
              '<div class="row-between">' +
                '<span class="badge ' + statusCls + '">' + escapeHtml(th.status || "open") + "</span>" +
                '<span class="mono muted" style="font-size:10px;">' + msgCount + " msgs</span>" +
              "</div>" +
              '<span style="font-size:11.5px;" class="truncate">' + escapeHtml(excerpt) + "</span>" +
            "</button>"
          );
        }).join("");
      }
    }

    const activePanel = document.getElementById("atBtwActivePanel");
    if (!activePanel) return;
    const thread = state.btwThreads.find((t) => t.btw_id === state.activeBtwId) || null;
    if (!thread) {
      activePanel.hidden = true;
      return;
    }
    activePanel.hidden = false;
    const statusEl = document.getElementById("atBtwActiveStatus");
    const anchorEl = document.getElementById("atBtwActiveAnchor");
    const msgsEl = document.getElementById("atBtwMessagesList");
    if (statusEl) {
      statusEl.className = "badge " + (thread.status === "promoted" ? "badge-emerald" : "badge-cyan");
      statusEl.textContent = thread.status || "open";
    }
    if (anchorEl) {
      const q = thread.anchor_quote || {};
      anchorEl.innerHTML =
        '<div><strong>Anchored Quote:</strong> "' + escapeHtml(q.excerpt || "") + '"</div>' +
        '<div class="mono muted" style="font-size:10px;margin-top:3px;">turn=' + escapeHtml(thread.anchor_turn_id || "") +
          (thread.promoted_source_id ? " · promoted_source=" + escapeHtml(thread.promoted_source_id) : "") +
        "</div>";
    }
    if (msgsEl) {
      const msgs = Array.isArray(thread.messages) ? thread.messages : [];
      msgsEl.innerHTML = msgs.map((m) => (
        '<div class="at-btw-msg ' + (String(m.role || "").toLowerCase() === "user" ? "is-user" : "is-assistant") + '">' +
          '<div class="row-between mono muted" style="font-size:10px;">' +
            "<strong>" + escapeHtml(m.role || "user") + "</strong>" +
            "<span>" + escapeHtml((m.message_id || "").slice(0, 12)) + "</span>" +
          "</div>" +
          '<div style="white-space:pre-wrap;overflow-wrap:anywhere;">' + escapeHtml(m.content || "") + "</div>" +
        "</div>"
      )).join("") || '<div class="muted mono" style="font-size:11px;">No messages yet.</div>';
    }
  }

  function renderSelectionBar() {
    const bar = document.getElementById("atSelectionBar");
    const preview = document.getElementById("atSelectionPreview");
    if (!bar || !preview) return;
    if (!state.activeSelection || !state.activeSelection.excerpt) {
      bar.hidden = true;
      preview.textContent = "";
      return;
    }
    bar.hidden = false;
    preview.textContent = '"' + state.activeSelection.excerpt + '" [' +
      state.activeSelection.char_start + ".." + state.activeSelection.char_end + "]";
  }

  function inspectCitation(marker, sourceId, chunkIdx) {
    const inspector = document.getElementById("atCitationInspector");
    const markerEl = document.getElementById("atCiteInspectorMarker");
    const titleEl = document.getElementById("atCiteInspectorTitle");
    const bodyEl = document.getElementById("atCiteInspectorBody");
    if (!inspector || !bodyEl) return;

    state.highlightedSourceId = sourceId;
    renderSources();
    const srcEl = document.querySelector('#atSourceList [data-source-id="' + CSS.escape(sourceId) + '"]');
    if (srcEl && typeof srcEl.scrollIntoView === "function") {
      srcEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    const ev = state.evidenceByMarker.get(marker) || null;
    const src = state.sources.find((s) => s.source_id === sourceId) || null;

    inspector.hidden = false;
    if (markerEl) markerEl.textContent = marker;
    if (titleEl) titleEl.textContent = (ev && ev.source_title) || (src && src.title) || sourceId;

    const parts = [];
    if (ev) {
      if (ev.heading) {
        parts.push('<div class="mono muted" style="font-size:10.5px;">Section: ' + escapeHtml(ev.heading) + "</div>");
      }
      parts.push('<div style="font-size:12px;line-height:1.5;">' + escapeHtml(ev.excerpt || "") + "</div>");
      parts.push(
        '<div class="mono muted" style="font-size:10px;">hybrid=' + escapeHtml(Number(ev.hybrid_score || 0).toFixed(3)) +
        " · bm25f=" + escapeHtml(Number(ev.bm25f_score || 0).toFixed(2)) +
        " · rag_bps=" + escapeHtml(String(ev.rag_relevance_bps || 0)) +
        " · provenance=" + escapeHtml(ev.provenance || "extracted") + "</div>"
      );
    }
    if (src) {
      parts.push(
        '<div class="mono muted" style="font-size:10.5px;">Source File: ' + escapeHtml(src.safe_filename || "") +
        " · " + escapeHtml(src.mime_type || "") +
        " · " + escapeHtml(String(src.chunk_count || 0)) + " chunks" +
        " · sha256:" + escapeHtml((src.content_sha256 || "").slice(0, 16)) + "</div>"
      );
    }
    if (!ev && !src) {
      parts.push('<div class="mono muted" style="font-size:11px;">Citation ' + escapeHtml(marker) + " references source " + escapeHtml(sourceId) + " chunk #" + escapeHtml(String(chunkIdx)) + " (not in current loaded source list).</div>");
    }
    bodyEl.innerHTML = parts.join("");

    document.querySelectorAll("#view-atelier .at-cite-chip").forEach((chip) => {
      chip.classList.toggle("is-active", chip.getAttribute("data-cite-marker") === marker);
    });
  }

  function captureSelectionFromDom() {
    const sel = global.getSelection ? global.getSelection() : null;
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text) return;

    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const endEl = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
    const startTurn = startEl ? startEl.closest(".at-turn-selectable[data-turn-id]") : null;
    const endTurn = endEl ? endEl.closest(".at-turn-selectable[data-turn-id]") : null;
    if (!startTurn || !endTurn || startTurn !== endTurn) return;

    const turnId = startTurn.getAttribute("data-turn-id");
    const surface = startTurn.getAttribute("data-turn-surface") || "notebook";

    let charStart = 0;
    let charEnd = text.length;
    try {
      const preStart = document.createRange();
      preStart.selectNodeContents(startTurn);
      preStart.setEnd(range.startContainer, range.startOffset);
      charStart = preStart.toString().length;

      const preEnd = document.createRange();
      preEnd.selectNodeContents(startTurn);
      preEnd.setEnd(range.endContainer, range.endOffset);
      charEnd = Math.max(charStart, preEnd.toString().length);
    } catch (_e) {
      charStart = 0;
      charEnd = text.length;
    }

    const citeEl = startEl ? startEl.closest("[data-cite-source-id]") : null;
    const sourceId = citeEl ? citeEl.getAttribute("data-cite-source-id") : null;

    state.activeSelection = {
      anchor_turn_id: turnId,
      surface,
      source_id: sourceId || undefined,
      excerpt: text.slice(0, 1200),
      char_start: charStart,
      char_end: charEnd
    };
    renderSelectionBar();
  }

  async function refreshStatus() {
    const res = await Studio.api.getNotebooksStatus();
    if (!res || !res.ok || !res.status) {
      state.status = null;
      state.statusError = {
        code: (res && res.code) || "notebooks_status_unavailable",
        message: (res && res.message) || "GET /api/notebooks/status failed."
      };
      renderStatus();
      return;
    }
    state.status = res.status;
    state.statusError = null;
    renderStatus();
  }

  async function refreshActiveNotebookData() {
    const nbId = state.activeNotebookId;
    if (!nbId) {
      state.sources = [];
      state.turns = [];
      state.artifacts = [];
      state.btwThreads = [];
      state.bridgeEvents = [];
      state.selectedArtifactId = null;
      state.activeBtwId = null;
      renderSources();
      renderEvidencePack();
      renderTurns();
      renderArtifacts();
      renderBtwDrawer();
      renderBridgeEvents();
      return;
    }

    const [srcRes, turnRes, artRes, btwRes, bridgeRes] = await Promise.all([
      Studio.api.listNotebookSources(nbId),
      Studio.api.listNotebookTurns(nbId),
      Studio.api.listNotebookArtifacts(nbId),
      Studio.api.listBtwThreads(nbId),
      Studio.api.listBridgeEvents(nbId)
    ]);

    const errors = [];
    if (srcRes && srcRes.ok) state.sources = Array.isArray(srcRes.sources) ? srcRes.sources : [];
    else errors.push((srcRes && srcRes.code) || "sources_error");

    if (turnRes && turnRes.ok) state.turns = Array.isArray(turnRes.turns) ? turnRes.turns : [];
    else errors.push((turnRes && turnRes.code) || "turns_error");

    if (artRes && artRes.ok) {
      state.artifacts = Array.isArray(artRes.artifacts) ? artRes.artifacts : [];
      if (state.selectedArtifactId && !state.artifacts.some((a) => a.artifact_id === state.selectedArtifactId)) {
        state.selectedArtifactId = null;
      }
    } else errors.push((artRes && artRes.code) || "artifacts_error");

    if (btwRes && btwRes.ok) {
      state.btwThreads = Array.isArray(btwRes.threads) ? btwRes.threads : [];
      if (state.activeBtwId && !state.btwThreads.some((t) => t.btw_id === state.activeBtwId)) {
        state.activeBtwId = state.btwThreads.length ? state.btwThreads[0].btw_id : null;
      }
    } else errors.push((btwRes && btwRes.code) || "btw_error");

    if (bridgeRes && bridgeRes.ok) state.bridgeEvents = Array.isArray(bridgeRes.events) ? bridgeRes.events : [];
    else errors.push((bridgeRes && bridgeRes.code) || "bridge_error");

    if (errors.length) {
      showBanner("atGlobalError", "error", "partial_load_error", "Failed endpoints: " + errors.join(", "));
    } else {
      showBanner("atGlobalError", null, null, null);
    }

    renderSources();
    renderEvidencePack();
    renderTurns();
    renderArtifacts();
    renderBtwDrawer();
    renderBridgeEvents();
  }

  async function refreshNotebooks() {
    const res = await Studio.api.listNotebooks();
    if (!res || !res.ok) {
      state.notebooks = [];
      state.activeNotebookId = null;
      showBanner("atGlobalError", "error", (res && res.code) || "notebooks_unavailable", (res && res.message) || "GET /api/notebooks failed.");
      renderNotebooks();
      await refreshActiveNotebookData();
      return;
    }
    showBanner("atGlobalError", null, null, null);
    state.notebooks = Array.isArray(res.notebooks) ? res.notebooks : [];
    if (state.activeNotebookId && !state.notebooks.some((n) => n.notebook_id === state.activeNotebookId)) {
      state.activeNotebookId = null;
    }
    if (!state.activeNotebookId && state.notebooks.length > 0) {
      state.activeNotebookId = state.notebooks[0].notebook_id;
    }
    renderNotebooks();
    await refreshActiveNotebookData();
  }

  async function refreshAll() {
    await Promise.all([refreshStatus(), refreshNotebooks()]);
  }

  function buildGroundedResponseMarkdown(pack) {
    const evidence = Array.isArray(pack && pack.evidence) ? pack.evidence : [];
    if (evidence.length === 0) {
      return "No matching source chunks were retrieved from the active notebook for this query.";
    }
    const lines = ["## Grounded Evidence Synthesis", ""];
    for (let i = 0; i < evidence.length; i++) {
      const ev = evidence[i];
      const marker = ev.citation_marker || ("[" + ev.source_id + ":" + ev.chunk_idx + "]");
      const title = ev.source_title || ev.source_id;
      const headingPart = ev.heading ? " (" + ev.heading + ")" : "";
      lines.push("- **" + title + "**" + headingPart + " " + marker + ": " + String(ev.excerpt || "").replace(/\s+/g, " ").trim());
    }
    return lines.join("\n");
  }

  async function handleModelChange(modelId, effort) {
    state.selectedModelId = modelId;
    state.selectedEffort = effort;
    syncModelEffortUi();
    const fb = document.getElementById("atModelFeedback");
    if (!state.activeNotebookId) {
      if (fb) fb.textContent = "Selection applies once a notebook is active.";
      return;
    }
    const res = await Studio.api.setNotebookModel(state.activeNotebookId, modelId, effort);
    if (!res || !res.ok) {
      if (fb) fb.textContent = "Error: " + ((res && res.code) || "model_update_failed") + " — " + ((res && res.message) || "");
      return;
    }
    const active = getActiveNotebook();
    if (active) {
      active.model_id = modelId;
      active.effort_level = effort;
    }
    renderNotebooks();
    if (fb) fb.textContent = "Saved " + modelId + " (" + effort + ").";
  }

  async function handleCreateQuoteCard(forBtw) {
    if (!state.activeNotebookId || !state.activeSelection) return;
    const payload = {
      notebook_id: state.activeNotebookId,
      surface: state.activeSelection.surface || "notebook",
      anchor_turn_id: state.activeSelection.anchor_turn_id,
      excerpt: state.activeSelection.excerpt,
      char_start: state.activeSelection.char_start,
      char_end: state.activeSelection.char_end
    };
    if (state.activeSelection.source_id) {
      payload.source_id = state.activeSelection.source_id;
    }

    const res = await Studio.api.createQuoteCard(payload);
    if (!res || !res.ok || !res.card) {
      showBanner("atGlobalError", "error", (res && res.code) || "quote_card_failed", (res && res.message) || "Failed to create quote card.");
      return;
    }

    if (forBtw) {
      state.stagedBtwQuote = res.card.quote;
      state.activeSelection = null;
      renderSelectionBar();
      setBtwDrawerOpen(true);
      renderBtwDrawer();
      const qInput = document.getElementById("atBtwQuestionInput");
      if (qInput) qInput.focus();
      return;
    }

    state.pendingQuoteCards.push(res.card);
    state.activeSelection = null;
    renderSelectionBar();
    renderQuoteChips();
  }

  function bindEvents() {
    // View mode toggle: Notebook | Gemini | Split
    const viewModeGroup = document.getElementById("atViewModeGroup");
    if (viewModeGroup) {
      const pick = (btn) => {
        const mode = btn.getAttribute("data-at-mode");
        if (mode) setViewMode(mode);
      };
      viewModeGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-at-mode]");
        if (btn) pick(btn);
      });
      bindRadiogroupKeyboard(viewModeGroup, "[data-at-mode]", pick);
    }

    // Model & Effort radiogroups
    const modelGroup = document.getElementById("atModelGroup");
    if (modelGroup) {
      const pick = (btn) => {
        const m = btn.getAttribute("data-at-model");
        if (m) handleModelChange(m, state.selectedEffort);
      };
      modelGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-at-model]");
        if (btn) pick(btn);
      });
      bindRadiogroupKeyboard(modelGroup, "[data-at-model]", pick);
    }

    const effortGroup = document.getElementById("atEffortGroup");
    if (effortGroup) {
      const pick = (btn) => {
        const ef = btn.getAttribute("data-at-effort");
        if (ef) handleModelChange(state.selectedModelId, ef);
      };
      effortGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-at-effort]");
        if (btn) pick(btn);
      });
      bindRadiogroupKeyboard(effortGroup, "[data-at-effort]", pick);
    }

    // 9-kind Artifact radiogroup
    const kindGroup = document.getElementById("atArtifactKindGroup");
    if (kindGroup) {
      const pick = (btn) => {
        const k = btn.getAttribute("data-at-kind");
        if (k && ARTIFACT_KINDS.includes(k)) {
          state.selectedArtifactKind = k;
          syncArtifactKindUi();
        }
      };
      kindGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-at-kind]");
        if (btn) pick(btn);
      });
      bindRadiogroupKeyboard(kindGroup, "[data-at-kind]", pick);
    }

    // BTW append role radiogroup
    const btwRoleGroup = document.getElementById("atBtwRoleGroup");
    if (btwRoleGroup) {
      const pick = (btn) => {
        const r = btn.getAttribute("data-at-btw-role");
        if (r === "user" || r === "assistant") {
          state.btwAppendRole = r;
          syncBtwRoleUi();
        }
      };
      btwRoleGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-at-btw-role]");
        if (btn) pick(btn);
      });
      bindRadiogroupKeyboard(btwRoleGroup, "[data-at-btw-role]", pick);
    }

    // Topbar buttons
    const refreshBtn = document.getElementById("btnAtRefreshAll");
    if (refreshBtn) refreshBtn.addEventListener("click", () => refreshAll());

    const toggleBtwBtn = document.getElementById("btnAtToggleBtwDrawer");
    if (toggleBtwBtn) {
      toggleBtwBtn.addEventListener("click", () => {
        setBtwDrawerOpen(!state.btwDrawerOpen);
        renderBtwDrawer();
      });
    }

    const closeBtwBtn = document.getElementById("btnAtCloseBtwDrawer");
    if (closeBtwBtn) closeBtwBtn.addEventListener("click", () => setBtwDrawerOpen(false));

    // Notebook Create / Select / Delete
    const createNbForm = document.getElementById("atCreateNotebookForm");
    if (createNbForm) {
      createNbForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const titleEl = document.getElementById("atNotebookTitleInput");
        const descEl = document.getElementById("atNotebookDescInput");
        const title = titleEl ? titleEl.value.trim() : "";
        const description = descEl ? descEl.value.trim() : "";
        if (!title) {
          showBanner("atNotebookFormFeedback", "error", "invalid_input", "Notebook title is required.");
          return;
        }
        const btn = document.getElementById("btnAtCreateNotebook");
        if (btn) btn.disabled = true;
        try {
          const res = await Studio.api.createNotebook({ title, description });
          if (!res || !res.ok || !res.notebook) {
            showBanner("atNotebookFormFeedback", "error", (res && res.code) || "create_notebook_failed", (res && res.message) || "Failed to create notebook.");
            return;
          }
          showBanner("atNotebookFormFeedback", null, null, null);
          if (titleEl) titleEl.value = "";
          if (descEl) descEl.value = "";
          state.activeNotebookId = res.notebook.notebook_id;
          state.latestPack = null;
          await Promise.all([refreshStatus(), refreshNotebooks()]);
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    const nbList = document.getElementById("atNotebookList");
    if (nbList) {
      nbList.addEventListener("click", async (e) => {
        const delBtn = e.target.closest("[data-at-delete-nb]");
        if (delBtn) {
          const nbId = delBtn.getAttribute("data-at-delete-nb");
          if (!nbId) return;
          delBtn.disabled = true;
          const res = await Studio.api.deleteNotebook(nbId);
          if (!res || !res.ok) {
            showBanner("atNotebookFormFeedback", "error", (res && res.code) || "delete_notebook_failed", (res && res.message) || "Failed to delete notebook.");
            delBtn.disabled = false;
            return;
          }
          if (state.activeNotebookId === nbId) {
            state.activeNotebookId = null;
            state.latestPack = null;
          }
          await Promise.all([refreshStatus(), refreshNotebooks()]);
          return;
        }

        const selBtn = e.target.closest("[data-at-select-nb]");
        if (selBtn) {
          const nbId = selBtn.getAttribute("data-at-select-nb");
          if (!nbId || nbId === state.activeNotebookId) return;
          state.activeNotebookId = nbId;
          state.highlightedSourceId = null;
          state.selectedArtifactId = null;
          state.activeBtwId = null;
          state.stagedBtwQuote = null;
          state.activeSelection = null;
          renderSelectionBar();
          renderNotebooks();
          await refreshActiveNotebookData();
        }
      });
    }

    // Source Ingest, Preview, Clear, Heal, Share Import
    const ingestForm = document.getElementById("atIngestForm");
    if (ingestForm) {
      ingestForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!state.activeNotebookId) {
          showBanner("atSourceActionFeedback", "error", "no_notebook", "Create or select a notebook first.");
          return;
        }
        const titleEl = document.getElementById("atSourceTitleInput");
        const fnEl = document.getElementById("atSourceFilenameInput");
        const textEl = document.getElementById("atSourceTextInput");
        const filename = fnEl ? fnEl.value.trim() : "";
        const text = textEl ? textEl.value : "";
        const title = titleEl ? titleEl.value.trim() : "";
        if (!filename || !text.trim()) {
          showBanner("atSourceActionFeedback", "error", "invalid_input", "Filename and source text are required.");
          return;
        }
        const btn = document.getElementById("btnAtIngestSource");
        if (btn) btn.disabled = true;
        try {
          const payload = {
            notebook_id: state.activeNotebookId,
            filename,
            text
          };
          if (title) payload.title = title;
          const res = await Studio.api.ingestNotebookSource(payload);
          if (!res || !res.ok || !res.outcome) {
            showBanner("atSourceActionFeedback", "error", (res && res.code) || "ingest_failed", (res && res.message) || "Source ingestion failed.");
            return;
          }
          const out = res.outcome;
          showBanner(
            "atSourceActionFeedback",
            "success",
            out.deduplicated ? "DEDUPLICATED" : "INGESTED",
            (out.source ? out.source.source_id : "") + " · " + String(out.chunk_count || 0) + " chunks · " + String(out.extracted_chars || 0) + " chars"
          );
          if (titleEl) titleEl.value = "";
          if (fnEl) fnEl.value = "";
          if (textEl) textEl.value = "";
          const prevBox = document.getElementById("atSourcePreviewBox");
          if (prevBox) prevBox.hidden = true;
          await refreshActiveNotebookData();
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    const previewBtn = document.getElementById("btnAtPreviewSource");
    if (previewBtn) {
      previewBtn.addEventListener("click", async () => {
        const fnEl = document.getElementById("atSourceFilenameInput");
        const textEl = document.getElementById("atSourceTextInput");
        const prevBox = document.getElementById("atSourcePreviewBox");
        if (!prevBox) return;
        const filename = fnEl ? fnEl.value.trim() : "";
        const text = textEl ? textEl.value : "";
        if (!filename) {
          showBanner("atSourceActionFeedback", "error", "invalid_input", "Enter a filename to preview.");
          return;
        }
        previewBtn.disabled = true;
        try {
          const res = await Studio.api.previewNotebookSource({ filename, text });
          prevBox.hidden = false;
          if (!res || !res.ok || !res.preview) {
            prevBox.innerHTML = '<div class="studio-error-banner"><span class="studio-error-code">' +
              escapeHtml((res && res.code) || "preview_failed") + "</span><span>" +
              escapeHtml((res && res.message) || "Preview failed.") + "</span></div>";
            return;
          }
          const p = res.preview;
          prevBox.innerHTML =
            '<div class="row-between"><span class="badge badge-cyan">' + escapeHtml(String(p.format || "preview")) +
            '</span><span class="mono muted" style="font-size:10px;">' + escapeHtml(p.mime_type || "") + " · " + escapeHtml(formatBytes(p.byte_size || 0)) + "</span></div>" +
            '<div class="mono" style="font-size:10.5px;">' + escapeHtml(p.safe_filename || filename) + "</div>";
        } finally {
          previewBtn.disabled = false;
        }
      });
    }

    const clearSourcesBtn = document.getElementById("btnAtClearSources");
    if (clearSourcesBtn) {
      clearSourcesBtn.addEventListener("click", async () => {
        if (!state.activeNotebookId) {
          showBanner("atSourceActionFeedback", "error", "no_notebook", "Select a notebook first.");
          return;
        }
        clearSourcesBtn.disabled = true;
        try {
          const res = await Studio.api.clearNotebookSources(state.activeNotebookId);
          if (!res || !res.ok) {
            showBanner("atSourceActionFeedback", "error", (res && res.code) || "clear_sources_failed", (res && res.message) || "Failed to clear sources.");
            return;
          }
          state.latestPack = null;
          state.highlightedSourceId = null;
          showBanner("atSourceActionFeedback", "info", "CLEARED", "Cleared sources for active notebook.");
          await refreshActiveNotebookData();
        } finally {
          clearSourcesBtn.disabled = false;
        }
      });
    }

    const healSourcesBtn = document.getElementById("btnAtHealSources");
    if (healSourcesBtn) {
      healSourcesBtn.addEventListener("click", async () => {
        if (!state.activeNotebookId) {
          showBanner("atSourceActionFeedback", "error", "no_notebook", "Select a notebook first.");
          return;
        }
        healSourcesBtn.disabled = true;
        try {
          const res = await Studio.api.healNotebookSources(state.activeNotebookId);
          if (!res || !res.ok) {
            showBanner("atSourceActionFeedback", "error", (res && res.code) || "heal_sources_failed", (res && res.message) || "Heal sweep failed.");
            return;
          }
          const rpt = res.report || res;
          showBanner(
            "atSourceActionFeedback",
            "success",
            "HEAL SWEEP",
            "inspected=" + String(rpt.inspected ?? 0) +
            " · healthy=" + String(rpt.already_healthy ?? 0) +
            " · healed=" + String(rpt.healed ?? 0) +
            " · quarantined=" + String(rpt.quarantined ?? 0)
          );
          await refreshActiveNotebookData();
        } finally {
          healSourcesBtn.disabled = false;
        }
      });
    }

    const shareForm = document.getElementById("atShareImportForm");
    if (shareForm) {
      shareForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fb = document.getElementById("atShareImportFeedback");
        if (!state.activeNotebookId) {
          if (fb) fb.textContent = "Select a notebook first.";
          return;
        }
        const urlEl = document.getElementById("atShareUrlInput");
        const url = urlEl ? urlEl.value.trim() : "";
        if (!url) return;
        if (fb) fb.textContent = "Importing public share…";
        const res = await Studio.api.importNotebookShare(state.activeNotebookId, url);
        if (!res || !res.ok || !res.outcome) {
          if (fb) fb.textContent = ((res && res.code) || "import_failed") + ": " + ((res && res.message) || "Share import failed.");
          return;
        }
        if (urlEl) urlEl.value = "";
        if (fb) fb.textContent = "Imported " + String(res.outcome.imported_turns || 0) + " turns -> " + (res.outcome.source ? res.outcome.source.source_id : "ok");
        await refreshActiveNotebookData();
      });
    }

    // Grounded Query Form: grounded-prompt -> render evidence -> record turn -> verify citations
    const groundedForm = document.getElementById("atGroundedForm");
    const groundedQueryEl = document.getElementById("atGroundedQueryInput");
    if (groundedQueryEl && groundedForm) {
      groundedQueryEl.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          groundedForm.requestSubmit();
        }
      });
    }
    if (groundedForm) {
      groundedForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!state.activeNotebookId) {
          showBanner("atGroundedFeedback", "error", "no_notebook", "Create or select a notebook before sending a grounded query.");
          return;
        }
        const query = groundedQueryEl ? groundedQueryEl.value.trim() : "";
        const maxChunks = Number((document.getElementById("atMaxChunksInput") || {}).value || 6);
        if (!query) {
          showBanner("atGroundedFeedback", "error", "invalid_input", "Enter a query.");
          return;
        }
        const btn = document.getElementById("btnAtSendGrounded");
        if (btn) btn.disabled = true;
        showBanner("atGroundedFeedback", "info", "Grounding", "Running POST /api/notebooks/grounded-prompt…");

        try {
          const packRes = await Studio.api.groundedPrompt(state.activeNotebookId, query, maxChunks);
          if (!packRes || !packRes.ok || !packRes.pack) {
            showBanner("atGroundedFeedback", "error", (packRes && packRes.code) || "grounded_prompt_failed", (packRes && packRes.message) || "Grounded prompt failed.");
            return;
          }
          const pack = packRes.pack;
          state.latestPack = pack;
          if (Array.isArray(pack.evidence)) {
            for (const ev of pack.evidence) {
              if (ev && ev.citation_marker) {
                state.evidenceByMarker.set(ev.citation_marker, ev);
              }
            }
          }
          renderEvidencePack();

          const responseMarkdown = buildGroundedResponseMarkdown(pack);
          const citations = Array.isArray(pack.evidence)
            ? pack.evidence.map((ev) => ev.citation_marker).filter(Boolean)
            : [];
          const quotes = state.pendingQuoteCards.map((c) => c.quote).filter(Boolean);
          const activeNb = getActiveNotebook();

          const turnRes = await Studio.api.recordNotebookTurn({
            notebook_id: state.activeNotebookId,
            surface: "notebook",
            prompt_text: query,
            response_markdown: responseMarkdown,
            model_id: (activeNb && activeNb.model_id) || state.selectedModelId,
            effort: (activeNb && activeNb.effort_level) || state.selectedEffort,
            quotes,
            citations
          });

          if (!turnRes || !turnRes.ok || !turnRes.turn) {
            showBanner("atGroundedFeedback", "error", (turnRes && turnRes.code) || "record_turn_failed", (turnRes && turnRes.message) || "Evidence retrieved, but recording turn failed.");
            return;
          }

          if (citations.length > 0) {
            const verRes = await Studio.api.verifyNotebookCitations(state.activeNotebookId, responseMarkdown);
            if (verRes && verRes.ok && verRes.report) {
              state.verificationByTurnId.set(turnRes.turn.turn_id, verRes.report);
            }
          }

          state.pendingQuoteCards = [];
          renderQuoteChips();
          if (groundedQueryEl) groundedQueryEl.value = "";
          showBanner("atGroundedFeedback", null, null, null);
          await refreshActiveNotebookData();
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    // Gemini Surface Form & Bridge to Notebook
    const geminiForm = document.getElementById("atGeminiForm");
    if (geminiForm) {
      geminiForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!state.activeNotebookId) {
          showBanner("atGeminiFeedback", "error", "no_notebook", "Select a notebook first.");
          return;
        }
        const pEl = document.getElementById("atGeminiPromptInput");
        const rEl = document.getElementById("atGeminiResponseInput");
        const promptText = pEl ? pEl.value.trim() : "";
        const responseMd = (rEl ? rEl.value.trim() : "") || promptText;
        if (!promptText) return;
        const activeNb = getActiveNotebook();
        const btn = document.getElementById("btnAtRecordGeminiTurn");
        if (btn) btn.disabled = true;
        try {
          const res = await Studio.api.recordNotebookTurn({
            notebook_id: state.activeNotebookId,
            surface: "gemini",
            prompt_text: promptText,
            response_markdown: responseMd,
            model_id: (activeNb && activeNb.model_id) || state.selectedModelId,
            effort: (activeNb && activeNb.effort_level) || state.selectedEffort,
            quotes: state.pendingQuoteCards.map((c) => c.quote).filter(Boolean),
            citations: []
          });
          if (!res || !res.ok) {
            showBanner("atGeminiFeedback", "error", (res && res.code) || "record_turn_failed", (res && res.message) || "Failed to record Gemini turn.");
            return;
          }
          state.pendingQuoteCards = [];
          renderQuoteChips();
          if (pEl) pEl.value = "";
          if (rEl) rEl.value = "";
          showBanner("atGeminiFeedback", null, null, null);
          await refreshActiveNotebookData();
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    const bridgeToNbBtn = document.getElementById("btnAtBridgeToNotebook");
    if (bridgeToNbBtn) {
      bridgeToNbBtn.addEventListener("click", async () => {
        if (!state.activeNotebookId) {
          showBanner("atGeminiFeedback", "error", "no_notebook", "Select a notebook first.");
          return;
        }
        const pEl = document.getElementById("atGeminiPromptInput");
        const rEl = document.getElementById("atGeminiResponseInput");
        const title = (pEl ? pEl.value.trim() : "") || "Gemini Bridge Note";
        const content = (rEl ? rEl.value.trim() : "") || (pEl ? pEl.value.trim() : "");
        if (!content) {
          showBanner("atGeminiFeedback", "error", "invalid_input", "Enter Gemini note content to bridge into Notebook sources.");
          return;
        }
        bridgeToNbBtn.disabled = true;
        try {
          const res = await Studio.api.bridgeTransfer({
            notebook_id: state.activeNotebookId,
            direction: "gemini_to_notebook",
            title,
            content
          });
          if (!res || !res.ok || !res.receipt) {
            showBanner("atGeminiFeedback", "error", (res && res.code) || "bridge_failed", (res && res.message) || "Cross-Bridge transfer failed.");
            return;
          }
          showBanner(
            "atGeminiFeedback",
            "success",
            "BRIDGED",
            "Created Notebook source " + (res.receipt.created_source ? res.receipt.created_source.source_id : res.receipt.event_id)
          );
          await refreshActiveNotebookData();
        } finally {
          bridgeToNbBtn.disabled = false;
        }
      });
    }

    // Delegated Clicks inside #view-atelier (citations, turn actions, quote chip removal)
    const atelierView = document.getElementById("view-atelier");
    if (atelierView) {
      atelierView.addEventListener("mouseup", () => {
        setTimeout(captureSelectionFromDom, 0);
      });
      atelierView.addEventListener("keyup", () => {
        captureSelectionFromDom();
      });

      atelierView.addEventListener("click", async (e) => {
        const citeBtn = e.target.closest(".at-cite-chip[data-cite-source-id]");
        if (citeBtn) {
          inspectCitation(
            citeBtn.getAttribute("data-cite-marker") || "",
            citeBtn.getAttribute("data-cite-source-id") || "",
            citeBtn.getAttribute("data-cite-chunk-idx") || "0"
          );
          return;
        }

        const rmQuote = e.target.closest("[data-at-remove-quote]");
        if (rmQuote) {
          const idx = Number(rmQuote.getAttribute("data-at-remove-quote"));
          if (Number.isInteger(idx) && idx >= 0 && idx < state.pendingQuoteCards.length) {
            state.pendingQuoteCards.splice(idx, 1);
            renderQuoteChips();
          }
          return;
        }

        const kbdSel = e.target.closest("[data-at-kbd-select-turn]");
        if (kbdSel) {
          const turnId = kbdSel.getAttribute("data-at-kbd-select-turn");
          const surface = kbdSel.getAttribute("data-at-kbd-surface") || "notebook";
          const turn = state.turns.find((t) => t.turn_id === turnId);
          if (!turn) return;
          const fullText = String(turn.response_markdown || turn.prompt_text || "").trim();
          const excerpt = fullText.slice(0, 280);
          if (!excerpt) return;
          state.activeSelection = {
            anchor_turn_id: turnId,
            surface,
            excerpt,
            char_start: 0,
            char_end: excerpt.length
          };
          renderSelectionBar();
          const quoteBtn = document.getElementById("btnAtSelectionQuote");
          if (quoteBtn) quoteBtn.focus();
          return;
        }

        const verifyBtn = e.target.closest("[data-at-verify-turn]");
        if (verifyBtn) {
          const turnId = verifyBtn.getAttribute("data-at-verify-turn");
          const turn = state.turns.find((t) => t.turn_id === turnId);
          if (!turn || !state.activeNotebookId) return;
          verifyBtn.disabled = true;
          const res = await Studio.api.verifyNotebookCitations(state.activeNotebookId, turn.response_markdown || "");
          verifyBtn.disabled = false;
          if (!res || !res.ok || !res.report) {
            showBanner("atGroundedFeedback", "error", (res && res.code) || "verify_failed", (res && res.message) || "Citation verification failed.");
            return;
          }
          state.verificationByTurnId.set(turnId, res.report);
          renderTurns();
          return;
        }

        const bridgeTurnBtn = e.target.closest("[data-at-bridge-turn]");
        if (bridgeTurnBtn) {
          const turnId = bridgeTurnBtn.getAttribute("data-at-bridge-turn");
          const dir = bridgeTurnBtn.getAttribute("data-at-bridge-dir");
          const turn = state.turns.find((t) => t.turn_id === turnId);
          if (!turn || !state.activeNotebookId) return;
          bridgeTurnBtn.disabled = true;
          const res = await Studio.api.bridgeTransfer({
            notebook_id: state.activeNotebookId,
            direction: dir,
            title: turn.prompt_text || ("Turn #" + turn.turn_index),
            content: turn.response_markdown || turn.prompt_text || "",
            source_ids: state.sources.map((s) => s.source_id)
          });
          bridgeTurnBtn.disabled = false;
          if (!res || !res.ok || !res.receipt) {
            showBanner("atGlobalError", "error", (res && res.code) || "bridge_failed", (res && res.message) || "Cross-Bridge transfer failed.");
            return;
          }
          if (dir === "notebook_to_gemini" && res.receipt.gemini_handoff_prompt) {
            setViewMode("split");
            const gp = document.getElementById("atGeminiPromptInput");
            const gr = document.getElementById("atGeminiResponseInput");
            if (gp) gp.value = "Bridge from Notebook: " + (turn.prompt_text || "").slice(0, 80);
            if (gr) gr.value = res.receipt.gemini_handoff_prompt;
          }
          await refreshActiveNotebookData();
        }
      });
    }

    // Selection Bar Buttons (Quote / BTW / Clear)
    const selQuoteBtn = document.getElementById("btnAtSelectionQuote");
    if (selQuoteBtn) selQuoteBtn.addEventListener("click", () => handleCreateQuoteCard(false));

    const selBtwBtn = document.getElementById("btnAtSelectionBtw");
    if (selBtwBtn) selBtwBtn.addEventListener("click", () => handleCreateQuoteCard(true));

    const selClearBtn = document.getElementById("btnAtSelectionClear");
    if (selClearBtn) {
      selClearBtn.addEventListener("click", () => {
        state.activeSelection = null;
        renderSelectionBar();
      });
    }

    const closeCiteBtn = document.getElementById("btnAtCloseCitationInspector");
    if (closeCiteBtn) {
      closeCiteBtn.addEventListener("click", () => {
        const el = document.getElementById("atCitationInspector");
        if (el) el.hidden = true;
      });
    }

    // BTW Drawer Forms & Thread Selection
    const cancelBtwCreateBtn = document.getElementById("btnAtCancelBtwCreate");
    if (cancelBtwCreateBtn) {
      cancelBtwCreateBtn.addEventListener("click", () => {
        state.stagedBtwQuote = null;
        renderBtwDrawer();
      });
    }

    const btwCreateForm = document.getElementById("atBtwCreateForm");
    if (btwCreateForm) {
      btwCreateForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!state.stagedBtwQuote) return;
        const qEl = document.getElementById("atBtwQuestionInput");
        const question = qEl ? qEl.value.trim() : "";
        if (!question) return;
        const btn = document.getElementById("btnAtCreateBtwSubmit");
        if (btn) btn.disabled = true;
        try {
          const res = await Studio.api.createBtwThread(state.stagedBtwQuote, question);
          if (!res || !res.ok || !res.thread) {
            showBanner("atBtwError", "error", (res && res.code) || "btw_create_failed", (res && res.message) || "Failed to create BTW thread.");
            return;
          }
          showBanner("atBtwError", null, null, null);
          state.stagedBtwQuote = null;
          if (qEl) qEl.value = "";
          state.activeBtwId = res.thread.btw_id;
          await refreshActiveNotebookData();
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    const btwThreadList = document.getElementById("atBtwThreadList");
    if (btwThreadList) {
      btwThreadList.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-at-select-btw]");
        if (!btn) return;
        state.activeBtwId = btn.getAttribute("data-at-select-btw");
        showBanner("atBtwPromoteFeedback", null, null, null);
        renderBtwDrawer();
      });
    }

    const btwAppendForm = document.getElementById("atBtwAppendForm");
    if (btwAppendForm) {
      btwAppendForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!state.activeBtwId) return;
        const inputEl = document.getElementById("atBtwAppendInput");
        const content = inputEl ? inputEl.value.trim() : "";
        if (!content) return;
        const btn = document.getElementById("btnAtBtwAppend");
        if (btn) btn.disabled = true;
        try {
          const res = await Studio.api.appendBtwMessage(state.activeBtwId, state.btwAppendRole, content);
          if (!res || !res.ok || !res.thread) {
            showBanner("atBtwError", "error", (res && res.code) || "btw_append_failed", (res && res.message) || "Failed to append BTW message.");
            return;
          }
          showBanner("atBtwError", null, null, null);
          if (inputEl) inputEl.value = "";
          const idx = state.btwThreads.findIndex((t) => t.btw_id === res.thread.btw_id);
          if (idx >= 0) state.btwThreads[idx] = res.thread;
          else state.btwThreads.unshift(res.thread);
          renderBtwDrawer();
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    const btwPromoteForm = document.getElementById("atBtwPromoteForm");
    if (btwPromoteForm) {
      btwPromoteForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!state.activeBtwId) return;
        const titleEl = document.getElementById("atBtwPromoteTitleInput");
        const title = titleEl ? titleEl.value.trim() : "";
        const btn = document.getElementById("btnAtBtwPromote");
        if (btn) btn.disabled = true;
        try {
          const res = await Studio.api.promoteBtwThread(state.activeBtwId, title);
          if (!res || !res.ok || !res.outcome) {
            showBanner("atBtwError", "error", (res && res.code) || "btw_promote_failed", (res && res.message) || "Failed to promote BTW thread.");
            return;
          }
          showBanner("atBtwError", null, null, null);
          if (titleEl) titleEl.value = "";
          const src = res.outcome.source;
          showBanner(
            "atBtwPromoteFeedback",
            "success",
            "PROMOTED",
            "Added source " + (src ? src.source_id + " (" + src.title + ")" : "ok") +
            (res.outcome.deduplicated ? " [deduplicated]" : "")
          );
          await refreshActiveNotebookData();
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    // Studio Artifacts Generate / Open / Rename / Delete
    const artForm = document.getElementById("atArtifactForm");
    if (artForm) {
      artForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!state.activeNotebookId) {
          showBanner("atArtifactFeedback", "error", "no_notebook", "Select a notebook first.");
          return;
        }
        const titleEl = document.getElementById("atArtifactTitleInput");
        const focusEl = document.getElementById("atArtifactFocusInput");
        const payload = {
          notebook_id: state.activeNotebookId,
          kind: state.selectedArtifactKind
        };
        if (titleEl && titleEl.value.trim()) payload.title = titleEl.value.trim();
        if (focusEl && focusEl.value.trim()) payload.focus_prompt = focusEl.value.trim();

        const btn = document.getElementById("btnAtGenerateArtifact");
        if (btn) btn.disabled = true;
        showBanner("atArtifactFeedback", "info", "Generating", "Synthesizing " + state.selectedArtifactKind + " artifact…");
        try {
          const res = await Studio.api.generateNotebookArtifact(payload);
          if (!res || !res.ok || !res.artifact) {
            showBanner("atArtifactFeedback", "error", (res && res.code) || "artifact_generate_failed", (res && res.message) || "Artifact generation failed.");
            return;
          }
          showBanner("atArtifactFeedback", null, null, null);
          if (titleEl) titleEl.value = "";
          if (focusEl) focusEl.value = "";
          state.selectedArtifactId = res.artifact.artifact_id;
          await refreshActiveNotebookData();
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    const artList = document.getElementById("atArtifactList");
    if (artList) {
      artList.addEventListener("click", async (e) => {
        const openBtn = e.target.closest("[data-at-open-artifact]");
        if (openBtn) {
          state.selectedArtifactId = openBtn.getAttribute("data-at-open-artifact");
          renderArtifacts();
          return;
        }
        const delBtn = e.target.closest("[data-at-delete-artifact]");
        if (delBtn) {
          const id = delBtn.getAttribute("data-at-delete-artifact");
          if (!id) return;
          delBtn.disabled = true;
          const res = await Studio.api.deleteNotebookArtifact(id);
          if (!res || !res.ok) {
            showBanner("atArtifactFeedback", "error", (res && res.code) || "artifact_delete_failed", (res && res.message) || "Failed to delete artifact.");
            delBtn.disabled = false;
            return;
          }
          if (state.selectedArtifactId === id) state.selectedArtifactId = null;
          await refreshActiveNotebookData();
        }
      });
    }

    const renameForm = document.getElementById("atArtifactRenameForm");
    if (renameForm) {
      renameForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!state.selectedArtifactId) return;
        const input = document.getElementById("atArtifactRenameInput");
        const title = input ? input.value.trim() : "";
        if (!title) return;
        const res = await Studio.api.renameNotebookArtifact(state.selectedArtifactId, title);
        if (!res || !res.ok) {
          showBanner("atArtifactFeedback", "error", (res && res.code) || "artifact_rename_failed", (res && res.message) || "Failed to rename artifact.");
          return;
        }
        showBanner("atArtifactFeedback", "success", "RENAMED", title);
        await refreshActiveNotebookData();
      });
    }

    const closeArtViewer = document.getElementById("btnAtCloseArtifactViewer");
    if (closeArtViewer) {
      closeArtViewer.addEventListener("click", () => {
        state.selectedArtifactId = null;
        renderArtifacts();
      });
    }
  }

  async function init() {
    setViewMode("notebook");
    syncModelEffortUi();
    syncArtifactKindUi();
    syncBtwRoleUi();
    bindEvents();
    await refreshAll();
  }

  function onActivate() {
    refreshAll();
  }

  Studio.atelier = {
    init,
    onActivate,
    refreshAll,
    setViewMode,
    isBtwDrawerOpen: () => state.btwDrawerOpen,
    closeBtwDrawer: () => setBtwDrawerOpen(false)
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
