"use strict";

(function initCommandPaletteModule(global) {
  const Studio = (global.OmniaStudio = global.OmniaStudio || {});
  const { escapeHtml } = Studio.utils;

  const paletteState = {
    open: false,
    query: "",
    activeIndex: 0,
    filtered: [],
    returnFocusEl: null
  };

  function getCommands() {
    return [
      { id: "view-chat", group: "Navigation", title: "Open Studio Chat & Scientific Rich Composer", hint: "Alt+1", keywords: "chat composer latex steer", run: () => Studio.switchView("chat") },
      { id: "view-graph", group: "Navigation", title: "Open 2-Way All-to-All PeerMeshGraph & Graphify Canvas", hint: "Alt+2", keywords: "peer graph duplex graphify bfs", run: () => Studio.switchView("graph") },
      { id: "view-router", group: "Navigation", title: "Open Dynamic Provider Router Workbench", hint: "Alt+3", keywords: "router quota circuit latency", run: () => Studio.switchView("router") },
      { id: "view-cpp", group: "Navigation", title: "Open Native C++20 Architecture & Proactive RAG Studio", hint: "Alt+4", keywords: "c++20 msvc rag uncertainty vietnamese", run: () => Studio.switchView("cpp-rag") },
      { id: "view-mem", group: "Navigation", title: "Open Hierarchical MemoryGraph & Curated Skill Vault", hint: "Alt+5", keywords: "memory erase sha256 skills vault", run: () => Studio.switchView("memory") },

      { id: "theme-obsidian", group: "Studio Theme", title: "Switch Theme: Obsidian Atelier (Signature Dark)", hint: "Theme 1", keywords: "dark obsidian theme", run: () => Studio.setTheme("obsidian") },
      { id: "theme-alabaster", group: "Studio Theme", title: "Switch Theme: Alabaster Editorial (Warm Museum Paper)", hint: "Theme 2", keywords: "light alabaster paper daylight theme", run: () => Studio.setTheme("alabaster") },
      { id: "theme-blueprint", group: "Studio Theme", title: "Switch Theme: Midnight Blueprint (Aerospace CAD Navy)", hint: "Theme 3", keywords: "navy blueprint cad cyan theme", run: () => Studio.setTheme("blueprint") },

      { id: "tex-maxwell", group: "Scientific LaTeX", title: "Insert Maxwell-Faraday Curl Equation (∇ × E)", hint: "Physics", keywords: "latex math maxwell curl", run: () => Studio.composer.insertLatexSnippet("\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}") },
      { id: "tex-schrodinger", group: "Scientific LaTeX", title: "Insert Time-Dependent Schrodinger Equation (iℏ ∂Ψ/∂t)", hint: "Physics", keywords: "latex quantum schrodinger", run: () => Studio.composer.insertLatexSnippet("i\\hbar \\frac{\\partial \\Psi}{\\partial t} = -\\frac{\\hbar^2}{2m}\\nabla^2 \\Psi + V\\Psi") },
      { id: "tex-gibbs", group: "Scientific LaTeX", title: "Insert Gibbs Free Energy Equilibrium (ΔG° = ΔH° − TΔS°)", hint: "Chemistry", keywords: "latex chemistry gibbs", run: () => Studio.composer.insertLatexSnippet("\\Delta G^\\circ = \\Delta H^\\circ - T\\Delta S^\\circ = -RT \\ln K_{eq}") },
      { id: "tex-gauss", group: "Scientific LaTeX", title: "Insert Gaussian Half-Line Integral (∫ e^{-αx²} dx)", hint: "Math", keywords: "latex integral gaussian", run: () => Studio.composer.insertLatexSnippet("\\int_{0}^{\\infty} e^{-\\alpha x^2} \\, dx = \\frac{1}{2}\\sqrt{\\frac{\\pi}{\\alpha}}") },

      { id: "sim-router-local", group: "Router Simulation", title: "Simulate Strict Local Zero-Retention Route Policy", hint: "POST /api/router/decide", keywords: "router local privacy zdr", run: () => { Studio.switchView("router"); Studio.routerLab.executeDecision({ privacyTier: "strict_local_zero_retention", taskClass: "code_generation" }); } },
      { id: "sim-router-trip", group: "Router Simulation", title: "Trip Primary Cloud Circuit Breaker & Verify Failover", hint: "Circuit Open", keywords: "trip circuit breaker failover", run: () => { Studio.switchView("router"); Studio.routerLab.executeDecision({ tripCandidate: "google-gemini-3-1-pro" }); } },
      { id: "sim-peer-broadcast", group: "Peer Mesh", title: "Dispatch Global @all 2-Way PeerMeshGraph Pulse", hint: "POST /api/graph/send", keywords: "broadcast peer pulse swarm", run: () => { Studio.switchView("graph"); Studio.peerGraph.broadcastPulse("Command Palette @all duplex synchronization pulse."); } },
      { id: "sess-create", group: "SQLite WAL", title: "Create New Cooperative WAL Studio Session", hint: "POST /api/sessions/create", keywords: "new session sqlite wal", run: () => Studio.createNewSession() }
    ];
  }

  function fuzzyScore(cmd, q) {
    if (!q) return 1;
    const hay = (cmd.title + " " + cmd.group + " " + cmd.keywords).toLowerCase();
    const needle = q.toLowerCase().trim();
    if (hay.includes(needle)) return 100 - hay.indexOf(needle);
    let hi = 0;
    for (let i = 0; i < needle.length; i++) {
      const ch = needle[i];
      if (ch === " ") continue;
      const found = hay.indexOf(ch, hi);
      if (found < 0) return 0;
      hi = found + 1;
    }
    return 25;
  }

  function renderResults() {
    const listEl = document.getElementById("cmdPaletteResults");
    if (!listEl) return;
    const all = getCommands();
    paletteState.filtered = all
      .map((cmd) => ({ cmd, score: fuzzyScore(cmd, paletteState.query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.cmd);

    if (paletteState.activeIndex >= paletteState.filtered.length) {
      paletteState.activeIndex = 0;
    }

    listEl.innerHTML = paletteState.filtered.map((cmd, idx) => (
      '<button type="button" class="cmd-item-btn ' + (idx === paletteState.activeIndex ? "is-highlighted" : "") +
        '" data-cmd-idx="' + idx + '">' +
        '<div class="row-wrap">' +
          '<span class="badge" style="font-size:10px;">' + escapeHtml(cmd.group) + "</span>" +
          '<span style="font-size:13px;font-weight:500;">' + escapeHtml(cmd.title) + "</span>" +
        "</div>" +
        '<span class="kbd-hint">' + escapeHtml(cmd.hint) + "</span>" +
      "</button>"
    )).join("") || '<div class="muted" style="padding:14px;font-size:12.5px;">No matching studio commands.</div>';
  }

  function open() {
    const modal = document.getElementById("commandPaletteModal");
    const input = document.getElementById("cmdPaletteInput");
    if (!modal || !input) return;
    paletteState.returnFocusEl = document.activeElement;
    paletteState.open = true;
    paletteState.query = "";
    paletteState.activeIndex = 0;
    modal.hidden = false;
    input.value = "";
    renderResults();
    input.focus();
  }

  function close() {
    const modal = document.getElementById("commandPaletteModal");
    if (modal) modal.hidden = true;
    paletteState.open = false;
    if (paletteState.returnFocusEl && typeof paletteState.returnFocusEl.focus === "function") {
      paletteState.returnFocusEl.focus();
    }
  }

  function executeIndex(idx) {
    const item = paletteState.filtered[idx];
    if (!item) return;
    close();
    item.run();
  }

  function init() {
    const modal = document.getElementById("commandPaletteModal");
    const input = document.getElementById("cmdPaletteInput");
    const list = document.getElementById("cmdPaletteResults");
    const openBtn = document.getElementById("btnOpenCommandPalette");

    if (openBtn) openBtn.addEventListener("click", open);

    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) close();
      });
    }

    if (input) {
      input.addEventListener("input", () => {
        paletteState.query = input.value;
        paletteState.activeIndex = 0;
        renderResults();
      });

      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (paletteState.filtered.length) {
            paletteState.activeIndex = (paletteState.activeIndex + 1) % paletteState.filtered.length;
            renderResults();
          }
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          if (paletteState.filtered.length) {
            paletteState.activeIndex = (paletteState.activeIndex - 1 + paletteState.filtered.length) % paletteState.filtered.length;
            renderResults();
          }
        } else if (e.key === "Enter") {
          e.preventDefault();
          executeIndex(paletteState.activeIndex);
        }
      });
    }

    if (list) {
      list.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-cmd-idx]");
        if (!btn) return;
        executeIndex(Number(btn.getAttribute("data-cmd-idx")));
      });
    }
  }

  Studio.commandPalette = {
    init,
    open,
    close,
    isOpen: () => paletteState.open
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
