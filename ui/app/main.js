"use strict";

(function initOmniaMain(global) {
  const Studio = (global.OmniaStudio = global.OmniaStudio || {});
  const { escapeHtml } = Studio.utils;

  const THEMES = ["obsidian", "alabaster", "blueprint"];
  const VIEWS = ["chat", "graph", "router", "cpp-rag", "memory"];

  const appState = {
    theme: "obsidian",
    activeView: "chat",
    railCollapsed: false,
    sessions: [],
    activeSessionId: "sess-cpp20-atelier"
  };

  function safeGetStorage(key) {
    try {
      return global.localStorage ? global.localStorage.getItem(key) : null;
    } catch (_e) {
      return null;
    }
  }

  function safeSetStorage(key, val) {
    try {
      if (global.localStorage) global.localStorage.setItem(key, val);
    } catch (_e) {
      // Ignore storage block on strict file:// sandboxes
    }
  }

  function setTheme(themeId) {
    const next = THEMES.includes(themeId) ? themeId : "obsidian";
    appState.theme = next;
    document.documentElement.setAttribute("data-theme", next);
    safeSetStorage("omnia.studio.theme", next);

    document.querySelectorAll("[data-theme-pick]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("data-theme-pick") === next));
    });

    if (Studio.peerGraph && typeof Studio.peerGraph.redraw === "function") {
      Studio.peerGraph.redraw();
    }
  }

  function switchView(viewId, optionalTargetId) {
    const next = VIEWS.includes(viewId) ? viewId : "chat";
    appState.activeView = next;

    document.querySelectorAll("[data-view-panel]").forEach((panel) => {
      const active = panel.getAttribute("data-view-panel") === next;
      panel.classList.toggle("is-active", active);
      panel.hidden = !active;
    });

    document.querySelectorAll("[data-nav-view]").forEach((btn) => {
      btn.setAttribute("aria-selected", String(btn.getAttribute("data-nav-view") === next));
    });

    if (next === "graph" && Studio.peerGraph) {
      if (optionalTargetId) Studio.peerGraph.focusNode(optionalTargetId);
      else Studio.peerGraph.redraw();
    } else if (next === "router" && optionalTargetId && Studio.routerLab) {
      Studio.routerLab.highlightCandidate(optionalTargetId);
    } else if (next === "cpp-rag" && optionalTargetId && Studio.ideExplorer) {
      Studio.ideExplorer.selectModule(optionalTargetId);
    }
  }

  async function refreshHealthTelemetry() {
    const health = await Studio.api.getHealth();
    const mode = Studio.api.getConnectionMode();
    const wsMb = ((Number(health.workingSetBytes) || 8388608) / (1024 * 1024)).toFixed(1);
    const binKb = Math.round((Number(health.binaryBytes) || 393216) / 1024);

    const dot = document.getElementById("headerPulseDot");
    const textEl = document.getElementById("headerTelemetryText");
    const extraEl = document.getElementById("headerTelemetryExtra");
    const footerMode = document.getElementById("footerConnectionMode");

    if (dot) dot.classList.toggle("is-standalone", mode !== "LIVE_CPP20");
    if (textEl) {
      textEl.textContent = "Native C++20 • " + (health.compiler || "MSVC 14.51").split(".")[0] + "." +
        ((health.compiler || "14.51").split(".")[1] || "51") +
        " • " + (health.rustFiles ?? 0) + " Rust";
    }
    if (extraEl) {
      extraEl.textContent = "• " + wsMb + " MB • " + binKb + " KB • " + (health.peerCount || 6) + " Peers";
    }
    if (footerMode) {
      footerMode.textContent = mode === "LIVE_CPP20"
        ? "LIVE C++20 RPC (127.0.0.1 • PID " + (health.pid || "—") + ")"
        : "STANDALONE ATELIER FALLBACK (0 CDN • 100% OFFLINE)";
    }
  }

  async function refreshSessions() {
    const res = await Studio.api.getSessions();
    appState.sessions = Array.isArray(res.sessions) ? res.sessions : [];
    const listEl = document.getElementById("railSessionList");
    const leaseEl = document.getElementById("railLeaseBadge");

    if (leaseEl && res.activeLease) {
      leaseEl.textContent = "WAL e" + (res.activeLease.leaseEpoch ?? 14);
    }
    if (!listEl) return;

    listEl.innerHTML = appState.sessions.map((s) => (
      '<button type="button" class="session-item ' + (s.id === appState.activeSessionId ? "is-active" : "") +
        '" data-session-id="' + escapeHtml(s.id) + '">' +
        '<span class="session-item-title">' + escapeHtml(s.title) + "</span>" +
        '<span class="session-item-meta">' + escapeHtml(s.modelId || "gemini-3.1-pro") + " • " + escapeHtml(s.effort || "high") + "</span>" +
      "</button>"
    )).join("");
  }

  async function createNewSession() {
    const idx = appState.sessions.length + 1;
    const res = await Studio.api.createSession({
      title: "Studio Run #" + idx + " • C++20 Verification",
      modelId: "gemini-3.1-pro",
      effort: "high"
    });
    if (res && res.session) {
      appState.activeSessionId = res.session.id;
    }
    await refreshSessions();
    switchView("chat");
  }

  async function bootstrap() {
    const savedTheme = safeGetStorage("omnia.studio.theme");
    setTheme(savedTheme || "obsidian");

    // Bind Header Theme Buttons
    document.querySelectorAll("[data-theme-pick]").forEach((btn) => {
      btn.addEventListener("click", () => setTheme(btn.getAttribute("data-theme-pick")));
    });

    // Bind Rail Collapse Toggle
    const shell = document.getElementById("omniaStudioShell");
    const railToggleBtn = document.getElementById("btnToggleRail");
    if (railToggleBtn && shell) {
      railToggleBtn.addEventListener("click", () => {
        appState.railCollapsed = !appState.railCollapsed;
        shell.classList.toggle("rail-collapsed", appState.railCollapsed);
        if (Studio.peerGraph) setTimeout(() => Studio.peerGraph.redraw(), 200);
      });
    }

    // Bind Left Rail View Navigation
    document.querySelectorAll("[data-nav-view]").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.getAttribute("data-nav-view")));
    });

    // Bind Telemetry Pill Refresh
    const pill = document.getElementById("btnHealthTelemetryPill");
    if (pill) pill.addEventListener("click", refreshHealthTelemetry);

    // Bind Session Creation & Switching
    const newSessBtn = document.getElementById("btnCreateSession");
    if (newSessBtn) newSessBtn.addEventListener("click", createNewSession);

    const sessList = document.getElementById("railSessionList");
    if (sessList) {
      sessList.addEventListener("click", (e) => {
        const item = e.target.closest("[data-session-id]");
        if (!item) return;
        appState.activeSessionId = item.getAttribute("data-session-id");
        refreshSessions();
        switchView("chat");
      });
    }

    // Global Keyboard Shortcuts (Ctrl+K, Alt+T, Alt+1..5, Ctrl+B, Escape)
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (Studio.commandPalette.isOpen()) Studio.commandPalette.close();
        else Studio.commandPalette.open();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (railToggleBtn) railToggleBtn.click();
        return;
      }
      if (e.altKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        const nextIdx = (THEMES.indexOf(appState.theme) + 1) % THEMES.length;
        setTheme(THEMES[nextIdx]);
        return;
      }
      if (e.altKey && /^[1-5]$/.test(e.key)) {
        e.preventDefault();
        switchView(VIEWS[Number(e.key) - 1]);
        return;
      }
      if (e.key === "Escape") {
        if (Studio.composer && Studio.composer.isPasteModalOpen()) {
          e.preventDefault();
          Studio.composer.cancelPasteModal();
          return;
        }
        if (Studio.commandPalette && Studio.commandPalette.isOpen()) {
          e.preventDefault();
          Studio.commandPalette.close();
        }
      }
    });

    // Initialize all 5 studio feature modules + command palette
    await Promise.all([
      refreshHealthTelemetry(),
      refreshSessions(),
      Studio.composer.init(),
      Studio.peerGraph.init(),
      Studio.routerLab.init(),
      Studio.ideExplorer.init(),
      Studio.memoryVault.init()
    ]);
    Studio.commandPalette.init();
    switchView("chat");
  }

  Studio.setTheme = setTheme;
  Studio.switchView = switchView;
  Studio.createNewSession = createNewSession;
  Studio.refreshHealthTelemetry = refreshHealthTelemetry;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
