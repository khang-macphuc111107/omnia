"use strict";

(function initOmniaMain(global) {
  const Studio = (global.OmniaStudio = global.OmniaStudio || {});
  const { escapeHtml } = Studio.utils;

  const THEMES = ["obsidian", "alabaster", "blueprint"];
  const VIEWS = ["chat", "graph", "router", "rust-rag", "memory"];

  const appState = {
    theme: "obsidian",
    activeView: "chat",
    railCollapsed: false,
    sessions: [],
    activeSessionId: null
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
    } else if (next === "rust-rag" && optionalTargetId && Studio.ideExplorer) {
      Studio.ideExplorer.selectModule(optionalTargetId);
    }
  }

  function capabilityBadgeClass(status) {
    const s = String(status || "").toLowerCase();
    if (s === "ready" || s === "paired" || s === "active" || s === "live") return "badge-emerald";
    if (s === "unconfigured" || s === "standby" || s === "idle" || s === "pairing_required") return "badge-amber";
    if (s === "unavailable" || s === "blocked" || s === "error" || s === "offline") return "badge-coral";
    return "badge-cyan";
  }

  function renderConnectorsCard(data) {
    const badgeEl = document.getElementById("capConnectorsSummaryBadge");
    const bodyEl = document.getElementById("capConnectorsBody");
    if (!bodyEl) return;
    if (!data || data.ok === false || data.state === "unavailable") {
      const code = data && data.httpStatus ? ("HTTP " + data.httpStatus) : "OFFLINE";
      if (badgeEl) {
        badgeEl.className = "badge badge-coral";
        badgeEl.textContent = code;
      }
      bodyEl.innerHTML =
        '<div class="cap-item-row">' +
          '<div class="cap-item-top">' +
            '<span class="cap-item-name">Connectors Probe</span>' +
            '<span class="badge badge-coral">unavailable</span>' +
          "</div>" +
          '<div class="cap-item-reason">' +
            escapeHtml((data && (data.message || data.error)) || "connectors_status_unavailable") +
          "</div>" +
        "</div>";
      return;
    }

    const list = Array.isArray(data.connectors) ? data.connectors : [];
    const readyCount = list.filter((c) => String(c.status || "").toLowerCase() === "ready").length;
    if (badgeEl) {
      badgeEl.className = "badge " + (readyCount > 0 ? "badge-emerald" : "badge-amber");
      badgeEl.textContent = readyCount + "/" + list.length + " ready";
    }
    if (!list.length) {
      bodyEl.innerHTML = '<div class="muted mono" style="font-size:11px;">No connectors reported by /api/connectors/status.</div>';
      return;
    }

    bodyEl.innerHTML = list.map((c) => {
      const reasonText = [c.reason, c.detail, c.endpoint].filter(Boolean).join(" • ") || "No additional status detail";
      return (
        '<div class="cap-item-row">' +
          '<div class="cap-item-top">' +
            '<span class="cap-item-name" title="' + escapeHtml(c.name) + '">' + escapeHtml(c.name) + "</span>" +
            '<span class="badge ' + capabilityBadgeClass(c.status) + '">' + escapeHtml(c.status) + "</span>" +
          "</div>" +
          '<div class="cap-item-reason">' + escapeHtml(reasonText) + "</div>" +
        "</div>"
      );
    }).join("");
  }

  function renderMediaCard(data) {
    const badgeEl = document.getElementById("capMediaSummaryBadge");
    const bodyEl = document.getElementById("capMediaBody");
    if (!bodyEl) return;
    if (!data || data.ok === false || data.state === "unavailable") {
      const code = data && data.httpStatus ? ("HTTP " + data.httpStatus) : "OFFLINE";
      if (badgeEl) {
        badgeEl.className = "badge badge-coral";
        badgeEl.textContent = code;
      }
      bodyEl.innerHTML =
        '<div class="cap-item-row">' +
          '<div class="cap-item-top">' +
            '<span class="cap-item-name">Media Capabilities</span>' +
            '<span class="badge badge-coral">unavailable</span>' +
          "</div>" +
          '<div class="cap-item-reason">' +
            escapeHtml((data && (data.message || data.error)) || "media_capabilities_unavailable") +
          "</div>" +
        "</div>";
      return;
    }

    const list = Array.isArray(data.capabilities) ? data.capabilities : [];
    const readyCount = list.filter((m) => String(m.status || "").toLowerCase() === "ready").length;
    if (badgeEl) {
      badgeEl.className = "badge " + (readyCount > 0 ? "badge-emerald" : "badge-amber");
      badgeEl.textContent = readyCount + "/" + list.length + " ready";
    }
    if (!list.length) {
      bodyEl.innerHTML = '<div class="muted mono" style="font-size:11px;">0 capture adapters reported (no synthetic devices).</div>';
      return;
    }

    bodyEl.innerHTML = list.map((m) => {
      const parts = [];
      if (m.reasonCode) parts.push("code:" + m.reasonCode);
      if (m.detail && m.detail !== m.reasonCode) parts.push(m.detail);
      if (m.endpointOrigin) parts.push(m.endpointOrigin);
      if (m.sourceVerified === true) parts.push("source_verified:true");
      else if (m.sourceVerified === false) parts.push("source_verified:false");
      if (m.latencyMs != null && Number.isFinite(Number(m.latencyMs))) parts.push(m.latencyMs + "ms");
      return (
        '<div class="cap-item-row">' +
          '<div class="cap-item-top">' +
            '<span class="cap-item-name" title="' + escapeHtml(m.name) + '">' + escapeHtml(m.name) + "</span>" +
            '<span class="badge ' + capabilityBadgeClass(m.status) + '">' + escapeHtml(m.status) + "</span>" +
          "</div>" +
          '<div class="cap-item-reason">' + escapeHtml(parts.join(" • ") || "No adapter detail reported") + "</div>" +
        "</div>"
      );
    }).join("");
  }

  function renderRemoteCard(data) {
    const badgeEl = document.getElementById("capRemoteSummaryBadge");
    const bodyEl = document.getElementById("capRemoteBody");
    if (!bodyEl) return;
    if (!data || data.ok === false || data.state === "unavailable") {
      const code = data && data.httpStatus ? ("HTTP " + data.httpStatus) : "OFFLINE";
      if (badgeEl) {
        badgeEl.className = "badge badge-coral";
        badgeEl.textContent = code;
      }
      bodyEl.innerHTML =
        '<div class="cap-item-row">' +
          '<div class="cap-item-top">' +
            '<span class="cap-item-name">Remote Control</span>' +
            '<span class="badge badge-coral">unavailable</span>' +
          "</div>" +
          '<div class="cap-item-reason">' +
            escapeHtml((data && (data.message || data.error)) || "remote_status_unavailable") +
          "</div>" +
        "</div>";
      return;
    }

    if (badgeEl) {
      badgeEl.className = "badge " + capabilityBadgeClass(data.status);
      badgeEl.textContent = data.status || "unknown";
    }

    const pairingLabel = data.pairing && typeof data.pairing === "object"
      ? (data.pairing.state || data.pairing.status || (data.pairing.required ? "pairing_required" : "idle"))
      : (data.pairing != null ? String(data.pairing) : "unreported");

    const replayLabel = data.replayWindow && typeof data.replayWindow === "object"
      ? ((data.replayWindow.windowMs ?? data.replayWindow.window_ms ?? "unreported") + " ms")
      : (data.replayWindow != null ? String(data.replayWindow) : "unreported");

    bodyEl.innerHTML =
      '<div class="cap-item-row">' +
        '<div class="cap-item-top">' +
          '<span class="cap-item-name">Protocol &amp; Pairing</span>' +
          '<span class="badge ' + capabilityBadgeClass(pairingLabel) + '">' + escapeHtml(String(pairingLabel)) + "</span>" +
        "</div>" +
        '<div class="cap-item-reason">' +
          escapeHtml((data.protocol || "omnia-remote-control") + (data.reason ? " • " + data.reason : "")) +
        "</div>" +
      "</div>" +
      '<div class="cap-item-row">' +
        '<div class="cap-item-top">' +
          '<span class="cap-item-name">Leases &amp; Replay Window</span>' +
          '<span class="badge badge-cyan">' + escapeHtml(String(data.activeLeases || 0)) + " active</span>" +
        "</div>" +
        '<div class="cap-item-reason">replay_window: ' + escapeHtml(replayLabel) + "</div>" +
      "</div>";
  }

  async function refreshCapabilityPanels() {
    const [connectors, media, remote] = await Promise.all([
      Studio.api.getConnectorsStatus(),
      Studio.api.getMediaCapabilities(),
      Studio.api.getRemoteStatus()
    ]);
    renderConnectorsCard(connectors);
    renderMediaCard(media);
    renderRemoteCard(remote);
  }

  async function triggerConnectorValidation() {
    const btn = document.getElementById("btnValidateConnectors");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Probing…";
    }
    try {
      const result = await Studio.api.validateConnectors();
      renderConnectorsCard(result);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Validate";
      }
    }
  }

  function openCapabilityInspector() {
    switchView("chat");
    const details = document.getElementById("capabilityInspectorDetails");
    if (details) {
      details.open = true;
      details.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    refreshCapabilityPanels();
  }

  async function refreshCapabilities() {
    const result = await Studio.api.getCapabilities();
    const statusEl = document.getElementById("footerCapabilityMode");
    if (!statusEl) return;
    if (result.ok !== true || !Array.isArray(result.capabilities)) {
      statusEl.textContent = "CAPABILITIES UNAVAILABLE";
      statusEl.title = result.error || "capabilities_endpoint_unavailable";
      return;
    }
    const available = result.capabilities.filter((item) =>
      item && item.available === true && item.live === true
    ).length;
    statusEl.textContent = "CAPABILITIES " + available + "/" + result.capabilities.length + " LIVE";
    statusEl.title = result.capabilities.map((item) =>
      String(item.id || "unknown") + ": " + String(item.state || "unavailable") +
      (item.reason ? " (" + String(item.reason) + ")" : "")
    ).join("\n");
  }

  async function refreshHealthTelemetry() {
    const [health, nvidia] = await Promise.all([
      Studio.api.getHealth(),
      Studio.api.getNvidiaHardware()
    ]);
    const mode = Studio.api.getConnectionMode();
    const liveHealth = health && health.ok !== false && health.state !== "unavailable";
    const formatMetric = (value, formatter) => {
      return typeof value === "number" && Number.isFinite(value)
        ? formatter(value)
        : "unavailable";
    };
    const wsMb = formatMetric(health.workingSetBytes, (value) => (value / (1024 * 1024)).toFixed(1) + " MB");
    const binKb = formatMetric(health.binaryBytes, (value) => Math.round(value / 1024) + " KB");
    const compiler = typeof health.compiler === "string" && health.compiler.trim()
      ? health.compiler.trim()
      : "rustc unreported";
    const cratePart = typeof health.crateCount === "number" && Number.isFinite(health.crateCount)
      ? String(health.crateCount) + " crates"
      : null;
    const rustFiles = typeof health.rustFiles === "number" && Number.isFinite(health.rustFiles)
      ? String(health.rustFiles) + " Rust files"
      : null;
    const peerCount = typeof health.peerCount === "number" && Number.isFinite(health.peerCount)
      ? String(health.peerCount) + " Peers"
      : "peer count unavailable";

    const dot = document.getElementById("headerPulseDot");
    const textEl = document.getElementById("headerTelemetryText");
    const extraEl = document.getElementById("headerTelemetryExtra");
    const footerMode = document.getElementById("footerConnectionMode");
    const nvidiaEl = document.getElementById("headerHardwareNvidia");

    if (dot) dot.classList.toggle("is-standalone", !liveHealth || mode !== "LIVE_RUST");
    if (textEl) {
      const parts = ["Omnia Full Native Rust", compiler, cratePart, rustFiles].filter(Boolean);
      textEl.textContent = liveHealth
        ? parts.join(" • ")
        : "Omnia Full Native Rust unavailable";
    }
    if (extraEl) {
      extraEl.textContent = liveHealth
        ? "• " + wsMb + " • " + binKb + " • " + peerCount
        : "Reason: " + (health.error || "health_endpoint_unavailable");
    }
    if (nvidiaEl) {
      const gpus = nvidia && Array.isArray(nvidia.gpus) ? nvidia.gpus : [];
      const nvidiaState = nvidia && typeof nvidia.state === "string"
        ? nvidia.state
        : "unavailable";
      if (nvidiaState === "ready" && gpus.length > 0) {
        const gpu = gpus[0];
        const name = typeof gpu.name === "string" && gpu.name.trim() ? gpu.name.trim() : "NVIDIA device";
        const freeValue = gpu.memoryFreeMiB ?? gpu.memory_free_mib;
        const totalValue = gpu.memoryTotalMiB ?? gpu.memory_total_mib;
        const free = Number.isFinite(Number(freeValue)) ? Number(freeValue) : null;
        const total = Number.isFinite(Number(totalValue)) ? Number(totalValue) : null;
        const memory = free !== null && total !== null ? " • " + free + "/" + total + " MiB free" : "";
        nvidiaEl.textContent = "NVIDIA device query • " + name + memory;
        nvidiaEl.title = "Live Rust hardware probe; CUDA, TensorRT and NVENC workloads remain unverified.";
      } else if (nvidiaState === "ready") {
        nvidiaEl.textContent = "NVIDIA device query • ready • no device rows";
        nvidiaEl.title = "The live NVIDIA hardware probe returned ready without device rows.";
      } else {
        const error = nvidia && typeof nvidia.error === "string" && nvidia.error.trim()
          ? nvidia.error.trim()
          : nvidiaState;
        nvidiaEl.textContent = "NVIDIA device query • " + error;
        nvidiaEl.title = nvidiaState === "error"
          ? "The live NVIDIA hardware probe returned an error."
          : "The live NVIDIA hardware probe is unavailable.";
      }
    }
    if (footerMode) {
      if (mode === "LIVE_RUST" && typeof health.pid === "number" && Number.isFinite(health.pid)) {
        footerMode.textContent = "LIVE RUST RPC (127.0.0.1 • PID " + health.pid + ")";
      } else if (mode === "LIVE_RUST") {
        footerMode.textContent = "LIVE RUST RPC (PID unavailable)";
      } else {
        footerMode.textContent = "RPC UNAVAILABLE • " + (health.error || "health_endpoint_unavailable");
      }
    }
  }

  async function refreshSessions() {
    const res = await Studio.api.getSessions();
    appState.sessions = Array.isArray(res.sessions) ? res.sessions : [];
    const listEl = document.getElementById("railSessionList");
    const leaseEl = document.getElementById("railLeaseBadge");

    if (appState.activeSessionId && !appState.sessions.some((s) => s.id === appState.activeSessionId)) {
      appState.activeSessionId = null;
    }
    if (!appState.activeSessionId && appState.sessions.length > 0) {
      appState.activeSessionId = appState.sessions[0].id;
    }
    if (leaseEl) {
      leaseEl.textContent = res.activeLease
        ? "WAL e" + (res.activeLease.leaseEpoch ?? "—")
        : (res.error || "WAL unavailable");
    }
    if (!listEl) return;

    if (res.state === "unavailable") {
      listEl.innerHTML = '<div class="muted" style="padding:8px 4px;">' +
        escapeHtml(res.error || "sessions_endpoint_unavailable") + "</div>";
      return;
    }
    if (appState.sessions.length === 0) {
      listEl.innerHTML = '<div class="muted" style="padding:8px 4px;">Live session store is empty.</div>';
      return;
    }

    listEl.innerHTML = appState.sessions.map((s) => (
      '<button type="button" class="session-item ' + (s.id === appState.activeSessionId ? "is-active" : "") +
        '" data-session-id="' + escapeHtml(s.id) + '">' +
        '<span class="session-item-title">' + escapeHtml(s.title) + "</span>" +
        '<span class="session-item-meta">' + escapeHtml(s.modelId || "model unavailable") + " • " + escapeHtml(s.effort || "effort unavailable") + "</span>" +
      "</button>"
    )).join("");
  }

  async function createNewSession() {
    const idx = appState.sessions.length + 1;
    const res = await Studio.api.createSession({
      title: "Studio Run #" + idx + " • Rust Verification",
      modelId: "gemini-3.1-pro",
      effort: "high"
    });
    if (res && res.session) {
      appState.activeSessionId = res.session.id;
    } else if (res && res.error) {
      const listEl = document.getElementById("railSessionList");
      if (listEl) {
        listEl.innerHTML = '<div class="muted" style="padding:8px 4px;">' +
          escapeHtml(res.error) + "</div>";
      }
      return;
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

    // Bind Telemetry Pill Refresh + Capability Cards Actions
    const pill = document.getElementById("btnHealthTelemetryPill");
    if (pill) pill.addEventListener("click", () =>
      Promise.all([refreshHealthTelemetry(), refreshCapabilities(), refreshCapabilityPanels()])
    );

    const footerCapBtn = document.getElementById("footerCapabilityMode");
    if (footerCapBtn) {
      footerCapBtn.addEventListener("click", openCapabilityInspector);
    }

    const validateConnBtn = document.getElementById("btnValidateConnectors");
    if (validateConnBtn) {
      validateConnBtn.addEventListener("click", (e) => {
        e.preventDefault();
        triggerConnectorValidation();
      });
    }

    const refreshCapsBtn = document.getElementById("btnRefreshCapabilityCards");
    if (refreshCapsBtn) {
      refreshCapsBtn.addEventListener("click", (e) => {
        e.preventDefault();
        Promise.all([refreshCapabilities(), refreshCapabilityPanels()]);
      });
    }

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

    // Initialize all 5 studio feature modules + capability cards + command palette
    await Promise.all([
      refreshCapabilities(),
      refreshHealthTelemetry(),
      refreshCapabilityPanels(),
      refreshSessions(),
      Studio.composer.init(),
      Studio.peerGraph.init(),
      Studio.routerLab.init(),
      Studio.ideExplorer.init(),
      Studio.memoryVault.init(),
      Studio.history.init()
    ]);
    Studio.commandPalette.init();
    switchView("chat");
  }

  Studio.setTheme = setTheme;
  Studio.switchView = switchView;
  Studio.createNewSession = createNewSession;
  Studio.refreshHealthTelemetry = refreshHealthTelemetry;
  Studio.refreshCapabilities = refreshCapabilities;
  Studio.refreshCapabilityPanels = refreshCapabilityPanels;
  Studio.openCapabilityInspector = openCapabilityInspector;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
