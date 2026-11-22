"use strict";

(function initOmniaHistory(global) {
  const Studio = (global.OmniaStudio = global.OmniaStudio || {});
  const { escapeHtml } = Studio.utils;
  const pageSize = 10;
  const messagePageSize = 20;
  const viewState = {
    query: "",
    offset: 0,
    totalMatched: 0,
    loading: false
  };

  const messageState = new Map();

  function stateLabel(state) {
    const value = String(state || "unavailable").toLowerCase();
    if (value === "empty") return "EMPTY";
    if (value === "partial") return "PARTIAL";
    if (value === "blocked") return "BLOCKED";
    if (value === "verified") return "VERIFIED";
    return "UNAVAILABLE";
  }

  function stateClass(state) {
    const value = String(state || "unavailable").toLowerCase();
    if (value === "partial") return "badge-amber";
    if (value === "blocked") return "badge-amber";
    if (value === "verified") return "badge-emerald";
    return "badge-cyan";
  }

  function acquisitionStateValue(state) {
    const value = String(state || "unavailable").toLowerCase();
    return value === "verified" || value === "partial" || value === "blocked"
      ? value
      : "unavailable";
  }

  function setLoading(loading) {
    viewState.loading = Boolean(loading);
    const button = document.getElementById("btnRefreshHistory");
    const searchButton = document.getElementById("btnSearchHistory");
    const previousButton = document.getElementById("btnHistoryPrevious");
    const nextButton = document.getElementById("btnHistoryNext");
    [button, searchButton].forEach((item) => {
      if (item) item.disabled = viewState.loading;
    });
    if (previousButton) previousButton.disabled = viewState.loading || viewState.offset <= 0;
    if (nextButton) {
      nextButton.disabled = viewState.loading ||
        viewState.offset + pageSize >= viewState.totalMatched;
    }
  }

  function countValue(counts, key) {
    const value = counts && counts[key];
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  function messageStateFor(recordId) {
    const key = String(recordId || "");
    if (!messageState.has(key)) {
      messageState.set(key, { offset: 0, totalMatched: 0, loading: false, open: false, request: 0 });
    }
    return messageState.get(key);
  }

  function messageStateLabel(state) {
    const value = String(state || "unavailable").toLowerCase();
    if (value === "empty") return "EMPTY";
    if (value === "blocked") return "BLOCKED";
    if (value === "partial") return "PARTIAL";
    if (value === "verified") return "VERIFIED";
    return "UNAVAILABLE";
  }

  function renderMessages(recordId, data, host) {
    if (!host) return;
    const state = String(data && data.state || "unavailable").toLowerCase();
    const detail = data && data.error ? " · " + escapeHtml(data.error) : "";
    const messages = Array.isArray(data && data.messages) ? data.messages : [];
    const total = Number.isFinite(Number(data && data.totalMatched))
      ? Number(data.totalMatched) : 0;
    const local = messageStateFor(recordId);
    local.totalMatched = total;
    const first = total === 0 ? 0 : local.offset + 1;
    const last = Math.min(local.offset + messages.length, total);
    const status = '<div class="mono muted" style="font-size:10px;margin:6px 0;">' +
      escapeHtml(messageStateLabel(state)) + detail +
      (total ? " · " + first + "–" + last + " of " + total : "") + "</div>";
    const body = messages.length
      ? messages.map((item) => {
        const role = String(item && item.role || "assistant").toLowerCase() === "user" ? "user" : "assistant";
        const roleLabel = role === "user" ? "User" : "Assistant";
        const timestamp = item && item.timestamp ? " · " + escapeHtml(item.timestamp) : "";
        const truncated = item && item.truncated ? " · truncated" : "";
        return '<div class="atelier-card" style="padding:8px 10px;margin-top:5px;">' +
          '<div class="row-between"><strong style="font-size:11px;">' + roleLabel +
          '</strong><span class="mono muted" style="font-size:10px;">' +
          escapeHtml(String(item && item.ordinal || "")) + timestamp + truncated +
          '</span></div><div style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.45;margin-top:4px;">' +
          escapeHtml(item && item.text || "") + "</div></div>";
      }).join("")
      : '<div class="muted" style="font-size:11px;padding:5px 0;">' +
        (state === "blocked" ? "This transcript is blocked by the redacted history contract."
          : state === "unavailable" ? "Transcript messages are unavailable."
            : state === "empty" ? "No transcript messages were returned."
              : "No transcript messages are eligible for display.") + "</div>";
    const controls = '<div class="row-between" style="margin-top:6px;align-items:center;">' +
      '<span class="mono muted" style="font-size:10px;">Transcript messages</span><div class="row-wrap" style="gap:5px;">' +
      '<button type="button" class="btn btn-subtle" data-history-message-prev="' + escapeHtml(recordId) +
      '" style="min-height:24px;padding:0 7px;"' + (local.loading || local.offset <= 0 ? " disabled" : "") + '>Previous</button>' +
      '<button type="button" class="btn btn-subtle" data-history-message-next="' + escapeHtml(recordId) +
      '" style="min-height:24px;padding:0 7px;"' + (local.loading || local.offset + messagePageSize >= total ? " disabled" : "") + '>Next</button>' +
      "</div></div>";
    host.innerHTML = status + body + controls;
  }

  async function loadMessages(recordId, host, options) {
    const local = messageStateFor(recordId);
    const opts = options || {};
    if (opts.reset) local.offset = 0;
    if (local.loading) return;
    local.loading = true;
    const request = ++local.request;
    renderMessages(recordId, { state: "unavailable", messages: [], totalMatched: local.totalMatched,
      error: "loading" }, host);
    try {
      let data = await Studio.api.getHistoryMessages(recordId, messagePageSize, local.offset);
      if (request !== local.request) return;
      const matched = Number.isFinite(Number(data && data.totalMatched)) ? Number(data.totalMatched) : 0;
      if (local.offset > 0 && local.offset >= matched && matched > 0) {
        local.offset = Math.floor((matched - 1) / messagePageSize) * messagePageSize;
        data = await Studio.api.getHistoryMessages(recordId, messagePageSize, local.offset);
      }
      local.loading = false;
      renderMessages(recordId, data, host);
    } catch (error) {
      if (request === local.request) {
        local.loading = false;
        renderMessages(recordId, {
          state: "blocked", messages: [], totalMatched: 0,
          error: String(error && error.message || "history_messages_refresh_failed")
        }, host);
      }
    } finally {
      if (request === local.request) local.loading = false;
    }
  }

  function render(data) {
    const statusEl = document.getElementById("historyStatusBadge");
    const acquisitionStatusEl = document.getElementById("historyAcquisitionBadge");
    const summaryEl = document.getElementById("historySummary");
    const recordsEl = document.getElementById("historyRecordsList");
    const nextEl = document.getElementById("historyNextActions");
    const pageEl = document.getElementById("historyPageStatus");
    const previousButton = document.getElementById("btnHistoryPrevious");
    const nextButton = document.getElementById("btnHistoryNext");
    if (!statusEl || !summaryEl || !recordsEl || !nextEl) return;

    const state = String(data && data.state || "unavailable").toLowerCase();
    const acquisitionState = acquisitionStateValue(data && data.acquisitionState);
    const counts = data && data.counts ? data.counts : {};
    viewState.totalMatched = Number.isFinite(Number(data && data.totalMatched))
      ? Number(data.totalMatched)
      : 0;
    statusEl.className = "badge " + stateClass(state);
    statusEl.textContent = stateLabel(state);
    if (acquisitionStatusEl) {
      acquisitionStatusEl.className = "badge " + stateClass(acquisitionState);
      acquisitionStatusEl.textContent = "ACQUISITION: " + stateLabel(acquisitionState);
    }

    const path = data && data.manifestPath ? " · " + escapeHtml(data.manifestPath) : "";
    const error = data && data.error ? " · " + escapeHtml(data.error) : "";
    const query = viewState.query ? ' · query="' + escapeHtml(viewState.query) + '"' : "";
    summaryEl.innerHTML =
      '<span class="mono">' + countValue(counts, "records") + " records</span>" +
      ' · <span class="mono">' + countValue(counts, "verified") + " verified</span>" +
      ' · <span class="mono">' + countValue(counts, "partial") + " partial</span>" +
      ' · <span class="mono">' + countValue(counts, "blocked") + " blocked</span>" +
      ' · <span class="mono">' + countValue(counts, "transcriptAvailable") + " transcript bodies available</span>" +
      query + path + error;

    const records = Array.isArray(data && data.records) ? data.records : [];
    messageState.clear();
    recordsEl.innerHTML = records.length
      ? records.map((record) => {
        const title = record.title || record.source_id || record.record_id || "Untitled history record";
        const preview = record.preview || "No preview exposed by the redacted manifest.";
        const source = record.source || "unknown";
        const retrieval = record.retrieval_state || "unknown";
        const recordId = record.record_id || record.source_id || "";
        const canOpen = Boolean(record.transcript_available && recordId);
        return (
          '<article class="atelier-card" style="padding:9px 11px;">' +
            '<div class="row-between">' +
              '<strong style="font-size:12px;">' + escapeHtml(title) + "</strong>" +
              '<span class="badge badge-cyan">' + escapeHtml(source) + "</span>" +
            "</div>" +
            '<div class="muted" style="font-size:11px;line-height:1.4;margin-top:4px;">' + escapeHtml(preview) + "</div>" +
            '<div class="mono muted" style="font-size:10px;margin-top:5px;">' +
              escapeHtml(record.timestamp || "timestamp unavailable") + " · retrieval=" + escapeHtml(retrieval) +
              (record.transcript_available ? " · transcript body available" : " · transcript body unavailable") +
            "</div>" +
            (canOpen
              ? '<button type="button" class="btn btn-subtle" data-history-messages-toggle="' + escapeHtml(recordId) +
                '" aria-expanded="false" style="margin-top:7px;min-height:25px;padding:0 8px;">View messages</button>' +
                '<div data-history-messages-panel="' + escapeHtml(recordId) + '" hidden></div>'
              : "") +
          "</article>"
        );
      }).join("")
      : '<div class="atelier-card" style="padding:10px 11px;font-size:11.5px;color:var(--ink-secondary);">' +
        (state === "blocked"
          ? "The redacted history manifest is blocked and cannot be displayed."
          : state === "unavailable"
            ? "No redacted history manifest is available to the Studio host."
            : state === "empty"
              ? "No redacted history records match the current query."
              : "The manifest contains no records eligible for display.") +
        "</div>";

    const completion = data && data.completion && Array.isArray(data.completion.next)
      ? data.completion.next
      : [];
    nextEl.innerHTML = completion.length
      ? completion.map((item) => '<li>' + escapeHtml(item) + "</li>").join("")
      : "<li>No next action supplied by the importer receipt.</li>";

    const first = viewState.totalMatched === 0 ? 0 : viewState.offset + 1;
    const last = Math.min(viewState.offset + records.length, viewState.totalMatched);
    if (pageEl) {
      pageEl.textContent = viewState.totalMatched
        ? first + "–" + last + " of " + viewState.totalMatched
        : "0 records";
    }
    if (previousButton) previousButton.disabled = viewState.loading || viewState.offset <= 0;
    if (nextButton) {
      nextButton.disabled = viewState.loading ||
        viewState.offset + pageSize >= viewState.totalMatched;
    }
  }

  async function refresh(options) {
    if (viewState.loading) return;
    const opts = options || {};
    if (opts.reset) viewState.offset = 0;
    const queryInput = document.getElementById("historyQuery");
    if (queryInput && opts.query !== undefined) queryInput.value = opts.query;
    if (queryInput && opts.query === undefined && viewState.query) queryInput.value = viewState.query;
    if (opts.query !== undefined) viewState.query = String(opts.query || "").trim();
    setLoading(true);
    try {
      let data = await Studio.api.getHistory(viewState.query, pageSize, viewState.offset);
      const matched = Number.isFinite(Number(data && data.totalMatched))
        ? Number(data.totalMatched)
        : 0;
      if (viewState.offset > 0 && viewState.offset >= matched &&
          data && (data.state === "empty" || data.state === "partial" || data.state === "verified")) {
        viewState.offset = matched > 0 ? Math.floor((matched - 1) / pageSize) * pageSize : 0;
        data = await Studio.api.getHistory(viewState.query, pageSize, viewState.offset);
      }
      render(data);
    } catch (error) {
      render({
        state: "blocked",
        acquisitionState: "unavailable",
        error: "history_refresh_failed",
        records: [],
        counts: {},
        completion: { next: [String(error && error.message || "retry history refresh")] }
      });
    } finally {
      setLoading(false);
    }
  }

  async function init() {
    const refreshButton = document.getElementById("btnRefreshHistory");
    const searchForm = document.getElementById("historySearchForm");
    const queryInput = document.getElementById("historyQuery");
    const previousButton = document.getElementById("btnHistoryPrevious");
    const nextButton = document.getElementById("btnHistoryNext");
    const recordsEl = document.getElementById("historyRecordsList");
    if (refreshButton) refreshButton.addEventListener("click", () => refresh());
    if (searchForm) {
      searchForm.addEventListener("submit", (event) => {
        event.preventDefault();
        refresh({ query: queryInput ? queryInput.value : "", reset: true });
      });
    }
    if (previousButton) {
      previousButton.addEventListener("click", () => {
        viewState.offset = Math.max(0, viewState.offset - pageSize);
        refresh();
      });
    }
    if (nextButton) {
      nextButton.addEventListener("click", () => {
        if (viewState.offset + pageSize >= viewState.totalMatched) return;
        viewState.offset += pageSize;
        refresh();
      });
    }
    if (recordsEl) {
      recordsEl.addEventListener("click", (event) => {
        const toggle = event.target.closest("[data-history-messages-toggle]");
        const previous = event.target.closest("[data-history-message-prev]");
        const next = event.target.closest("[data-history-message-next]");
        const recordId = (toggle || previous || next) &&
          (toggle || previous || next).getAttribute(
            toggle ? "data-history-messages-toggle" :
              previous ? "data-history-message-prev" : "data-history-message-next");
        if (!recordId) return;
        const host = Array.from(recordsEl.querySelectorAll("[data-history-messages-panel]"))
          .find((item) => item.getAttribute("data-history-messages-panel") === recordId);
        if (!host) return;
        const local = messageStateFor(recordId);
        if (toggle) {
          local.open = !local.open;
          toggle.setAttribute("aria-expanded", String(local.open));
          toggle.textContent = local.open ? "Hide messages" : "View messages";
          host.hidden = !local.open;
          if (local.open && !host.dataset.loaded) {
            host.dataset.loaded = "true";
            loadMessages(recordId, host);
          }
          return;
        }
        if (previous) local.offset = Math.max(0, local.offset - messagePageSize);
        if (next) {
          if (local.offset + messagePageSize >= local.totalMatched) return;
          local.offset += messagePageSize;
        }
        loadMessages(recordId, host);
      });
    }
    await refresh();
  }

  Studio.history = { init, refresh };
})(typeof globalThis !== "undefined" ? globalThis : window);
