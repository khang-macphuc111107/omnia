"use strict";

(function initOmniDriveModule(global) {
  const Studio = (global.OmniaStudio = global.OmniaStudio || {});
  const { escapeHtml } = Studio.utils;

  const PACING_NOTES = {
    turbo: "Aggressive parallel range streaming up to configured stream cap (1-128).",
    adaptive: "AIMD + BDP adaptive concurrency responding to RTT and 429/503 signals.",
    polite: "Single-stream polite mode with inter-segment delay (clamps streams to 1).",
    linear_rate_guarded: "Strictly sequential single-stream transfer with rate guard (clamps streams to 1)."
  };

  const state = {
    pacingMode: "adaptive",
    streams: 16,
    jobsOrder: [],
    jobsById: new Map(),
    liveById: new Map(),
    segmentsById: new Map(),
    expandedJobIds: new Set(),
    jobsError: null,
    handoffs: [],
    handoffsError: null,
    providers: [],
    categories: [],
    activeCategory: "all",
    providersError: null,
    sse: null,
    sseState: "standby",
    hydratedJobIds: new Set()
  };

  function formatSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return "0 B";
    if (n < 1024) return Math.round(n) + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KiB";
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + " MiB";
    return (n / (1024 * 1024 * 1024)).toFixed(2) + " GiB";
  }

  function formatSpeed(bps) {
    const n = Number(bps);
    if (!Number.isFinite(n) || n <= 0) return "0 B/s";
    return formatSize(n) + "/s";
  }

  function formatEta(secs) {
    if (secs === null || secs === undefined) return "—";
    const s = Math.max(0, Math.round(Number(secs)));
    if (!Number.isFinite(s)) return "—";
    if (s < 60) return s + "s";
    const mins = Math.floor(s / 60);
    const remS = s % 60;
    if (mins < 60) return mins + "m " + String(remS).padStart(2, "0") + "s";
    const hrs = Math.floor(mins / 60);
    const remM = mins % 60;
    return hrs + "h " + String(remM).padStart(2, "0") + "m";
  }

  function basenameOf(pathStr) {
    const raw = String(pathStr || "").trim();
    if (!raw) return "";
    const normalized = raw.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : raw;
  }

  function statusBadgeClass(status) {
    const s = String(status || "").toLowerCase();
    if (s === "completed") return "badge-emerald";
    if (s === "downloading" || s === "verifying") return "badge-cyan";
    if (s === "queued" || s === "probing" || s === "paused") return "badge-amber";
    return "badge-coral";
  }

  function progressFillClass(status) {
    const s = String(status || "").toLowerCase();
    if (s === "completed") return "is-complete";
    if (s === "paused" || s === "queued" || s === "probing") return "is-paused";
    if (s === "failed" || s === "cancelled" || s === "blocked_policy" || s === "awaiting_manual_handoff") {
      return "is-error";
    }
    return "";
  }

  function showErrorBanner(elId, code, message) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!code && !message) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.className = "studio-error-banner";
    el.hidden = false;
    el.innerHTML =
      '<span class="studio-error-code">' + escapeHtml(code || "error") + "</span>" +
      "<span>" + escapeHtml(message || "Request failed.") + "</span>";
  }

  function showFeedbackBanner(elId, kind, title, detail) {
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

  function mergeIntervals(intervals) {
    if (!intervals.length) return [];
    const sorted = intervals
      .filter((pair) => Number.isFinite(pair[0]) && Number.isFinite(pair[1]) && pair[1] > pair[0])
      .sort((a, b) => a[0] - b[0]);
    if (!sorted.length) return [];
    const merged = [[sorted[0][0], sorted[0][1]]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = merged[merged.length - 1];
      const cur = sorted[i];
      if (cur[0] <= prev[1]) {
        if (cur[1] > prev[1]) prev[1] = cur[1];
      } else {
        merged.push([cur[0], cur[1]]);
      }
    }
    return merged;
  }

  function compute128CellFractions(totalBytes, completedRanges, segments, status) {
    const total = Number(totalBytes || 0);
    const out = new Array(128).fill(0);
    if (!Number.isFinite(total) || total <= 0) {
      if (String(status || "").toLowerCase() === "completed") {
        out.fill(1);
      }
      return out;
    }

    const halfOpen = [];
    if (Array.isArray(completedRanges) && completedRanges.length > 0) {
      for (const pair of completedRanges) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const s = Math.max(0, Math.min(total, Number(pair[0])));
        const eExclusive = Math.max(s, Math.min(total, Number(pair[1]) + 1));
        if (eExclusive > s) halfOpen.push([s, eExclusive]);
      }
    } else if (Array.isArray(segments) && segments.length > 0) {
      for (const seg of segments) {
        if (!seg) continue;
        const start = Math.max(0, Math.min(total, Number(seg.start || 0)));
        const endExclusive = Math.max(start, Math.min(total, Number(seg.end || 0) + 1));
        if (seg.is_completed) {
          if (endExclusive > start) halfOpen.push([start, endExclusive]);
        } else {
          const downloaded = Math.max(0, Number(seg.downloaded || 0));
          const coveredEnd = Math.min(endExclusive, start + downloaded);
          if (coveredEnd > start) halfOpen.push([start, coveredEnd]);
        }
      }
    } else if (String(status || "").toLowerCase() === "completed") {
      out.fill(1);
      return out;
    }

    const merged = mergeIntervals(halfOpen);
    if (!merged.length) return out;

    const cellSpan = total / 128;
    for (let i = 0; i < 128; i++) {
      const cStart = i * cellSpan;
      const cEnd = (i + 1) * cellSpan;
      let covered = 0;
      for (let j = 0; j < merged.length; j++) {
        const iv = merged[j];
        if (iv[1] <= cStart) continue;
        if (iv[0] >= cEnd) break;
        const ovStart = iv[0] > cStart ? iv[0] : cStart;
        const ovEnd = iv[1] < cEnd ? iv[1] : cEnd;
        if (ovEnd > ovStart) covered += (ovEnd - ovStart);
      }
      out[i] = cellSpan > 0 ? Math.max(0, Math.min(1, covered / cellSpan)) : 0;
    }
    return out;
  }

  function cellLevelClass(frac) {
    if (frac <= 0) return "od-cell-0";
    if (frac < 0.35) return "od-cell-1";
    if (frac < 0.70) return "od-cell-2";
    if (frac < 0.999) return "od-cell-3";
    return "od-cell-4";
  }

  function updateSseBadge(mode, detail) {
    state.sseState = mode;
    const badge = document.getElementById("odSseStatusBadge");
    if (!badge) return;
    if (mode === "live") {
      badge.className = "badge badge-emerald";
      badge.textContent = "SSE LIVE";
      badge.title = detail || "Connected to /api/downloads/events";
    } else if (mode === "connecting") {
      badge.className = "badge badge-amber";
      badge.textContent = "SSE CONNECTING";
      badge.title = detail || "Connecting to /api/downloads/events";
    } else if (mode === "error") {
      badge.className = "badge badge-coral";
      badge.textContent = "SSE OFFLINE";
      badge.title = detail || "EventSource disconnected; click Refresh to reconnect";
    } else {
      badge.className = "badge badge-cyan";
      badge.textContent = "SSE STANDBY";
      badge.title = detail || "EventSource opens when OmniDrive view is active";
    }
  }

  function syncPacingUi() {
    const group = document.getElementById("odPacingGroup");
    if (group) {
      group.querySelectorAll("[data-od-pacing]").forEach((btn) => {
        const active = btn.getAttribute("data-od-pacing") === state.pacingMode;
        btn.setAttribute("aria-checked", String(active));
        btn.tabIndex = active ? 0 : -1;
      });
    }
    const noteEl = document.getElementById("odPacingNote");
    if (noteEl) noteEl.textContent = PACING_NOTES[state.pacingMode] || "";
    const effEl = document.getElementById("odStreamsEffectiveNote");
    if (effEl) {
      if (state.pacingMode === "polite" || state.pacingMode === "linear_rate_guarded") {
        effEl.textContent = "effective: 1 stream";
      } else {
        effEl.textContent = "up to " + state.streams + " streams";
      }
    }
  }

  function renderProbeOrResource(kind, payload) {
    const box = document.getElementById("odProbeResult");
    if (!box) return;
    if (!payload) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    if (kind === "probe") {
      const p = payload;
      const rows = [
        ["URL", p.sanitized_url || "—"],
        ["Filename", p.suggested_filename || "—"],
        ["Total Size", p.total_size != null ? formatSize(p.total_size) + " (" + Number(p.total_size).toLocaleString() + " B)" : "unknown"],
        ["Byte Ranges", p.supports_ranges ? "Supported (206 Partial Content)" : "Single-stream only"],
        ["Validator", p.validator_strength || "none"],
        ["Content-Type", p.content_type || "unreported"]
      ];
      if (p.etag) rows.push(["ETag", p.etag]);
      if (p.goog_crc32c_b64) rows.push(["x-goog-crc32c", p.goog_crc32c_b64]);
      if (p.goog_md5_b64) rows.push(["x-goog-md5", p.goog_md5_b64]);

      box.innerHTML =
        '<div class="row-between">' +
          '<span class="badge badge-emerald">PROBE OK</span>' +
          (p.suggested_filename
            ? '<button type="button" class="btn btn-subtle btn-xs" data-od-fill-filename="' + escapeHtml(p.suggested_filename) + '">Use Filename</button>'
            : "") +
        "</div>" +
        '<div class="od-kv-grid">' +
          rows.map((r) => '<span class="od-kv-key">' + escapeHtml(r[0]) + '</span><span class="od-kv-val">' + escapeHtml(r[1]) + "</span>").join("") +
        "</div>";
      return;
    }

    if (kind === "drive") {
      const r = payload;
      const rows = [
        ["File ID", r.file_id || "—"],
        ["Kind", r.kind || "—"],
        ["Canonical URL", r.canonical_url || "—"]
      ];
      if (r.resource_key) rows.push(["Resource Key", r.resource_key]);
      if (r.auth_user != null) rows.push(["Auth User", String(r.auth_user)]);
      box.innerHTML =
        '<div class="row-between">' +
          '<span class="badge badge-cyan">DRIVE RESOLVED</span>' +
          (r.kind === "folder" && r.file_id
            ? '<button type="button" class="btn btn-subtle btn-xs" data-od-fill-folder="' + escapeHtml(r.file_id) + '">Use in Folder Planner</button>'
            : "") +
        "</div>" +
        '<div class="od-kv-grid">' +
          rows.map((row) => '<span class="od-kv-key">' + escapeHtml(row[0]) + '</span><span class="od-kv-val">' + escapeHtml(row[1]) + "</span>").join("") +
        "</div>";
    }
  }

  function renderJobsTable() {
    const tbody = document.getElementById("odJobsTableBody");
    const countBadge = document.getElementById("odJobCountBadge");
    const throughputEl = document.getElementById("odThroughputReadout");
    if (!tbody) return;

    showErrorBanner("odJobsError", state.jobsError ? state.jobsError.code : null, state.jobsError ? state.jobsError.message : null);

    const jobs = state.jobsOrder
      .map((id) => state.jobsById.get(id))
      .filter(Boolean);

    if (countBadge) {
      const activeCount = jobs.filter((j) => {
        const s = String(j.status || "").toLowerCase();
        return s === "downloading" || s === "queued" || s === "probing" || s === "verifying";
      }).length;
      countBadge.textContent = jobs.length + " jobs" + (activeCount ? " · " + activeCount + " active" : "");
    }

    if (throughputEl) {
      let totalBps = 0;
      for (const j of jobs) {
        const live = state.liveById.get(j.job_id);
        if (live && String(j.status || "").toLowerCase() === "downloading") {
          totalBps += Number(live.speed_bps || 0);
        }
      }
      throughputEl.textContent = formatSpeed(totalBps);
    }

    if (jobs.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="muted mono" style="padding:14px;">' +
        (state.jobsError
          ? "Download queue unavailable (" + escapeHtml(state.jobsError.code) + ")."
          : "No download jobs recorded yet. Probe a URL and start a segmented transfer on the left.") +
        "</td></tr>";
      return;
    }

    tbody.innerHTML = jobs.map((job) => {
      const id = job.job_id;
      const live = state.liveById.get(id) || null;
      const segs = state.segmentsById.get(id) || null;
      const status = String((live && live.status) || job.status || "queued");
      const statusLow = status.toLowerCase();
      const totalBytes = Number((live && live.total_bytes != null ? live.total_bytes : job.total_bytes) || 0);
      const downloadedBytes = Number((live && live.downloaded_bytes != null ? live.downloaded_bytes : job.downloaded_bytes) || 0);
      const pct = totalBytes > 0
        ? Math.max(0, Math.min(100, (downloadedBytes / totalBytes) * 100))
        : (statusLow === "completed" ? 100 : 0);
      const speedBps = live ? Number(live.speed_bps || 0) : 0;
      const activeStreams = live && live.active_streams != null ? live.active_streams : (job.streams || 0);
      const etaSecs = live ? live.eta_secs : null;
      const errorCode = (live && live.error_code) || job.error_code || null;
      const displayName = basenameOf(job.destination_path) || job.job_id;
      const isTerminal = statusLow === "completed" || statusLow === "cancelled" || statusLow === "failed" || statusLow === "blocked_policy";
      const canPause = !isTerminal && statusLow !== "paused";
      const canCancel = statusLow !== "completed" && statusLow !== "cancelled";

      const completedRanges = live && Array.isArray(live.completed_ranges) ? live.completed_ranges : null;
      const cells = compute128CellFractions(totalBytes, completedRanges, segs, statusLow);
      const cellSpans = cells.map((frac, idx) =>
        '<span class="od-chunk-cell ' + cellLevelClass(frac) +
        '" data-cell-idx="' + idx +
        '" data-fraction="' + frac.toFixed(3) +
        '" title="Cell ' + (idx + 1) + "/128: " + Math.round(frac * 100) + '%"></span>'
      ).join("");

      const mapSourceLabel = completedRanges && completedRanges.length
        ? "SSE completed_ranges (" + completedRanges.length + " spans)"
        : segs && segs.length
          ? "segments (" + segs.length + " ranges)"
          : "status snapshot";

      const isExpanded = state.expandedJobIds.has(id);
      const segDetailHtml = isExpanded
        ? (segs && segs.length
          ? '<div class="mono muted" style="font-size:10px;margin-top:6px;max-height:110px;overflow-y:auto;">' +
              segs.map((s) => {
                const segLen = Math.max(0, Number(s.end) - Number(s.start) + 1);
                return "<div>#" + escapeHtml(String(s.chunk_id)) + " [" +
                  escapeHtml(String(s.start)) + ".." + escapeHtml(String(s.end)) + "] " +
                  escapeHtml(formatSize(s.downloaded)) + "/" + escapeHtml(formatSize(segLen)) +
                  (s.is_completed ? " · DONE" : " · ACTIVE") + "</div>";
              }).join("") +
            "</div>"
          : '<div class="mono muted" style="font-size:10px;margin-top:6px;">No segment rows reported for this job yet.</div>')
        : "";

      return (
        '<tr class="od-job-main-row" data-od-job-id="' + escapeHtml(id) + '">' +
          "<td>" +
            '<div class="od-job-title" title="' + escapeHtml(job.destination_path || id) + '">' + escapeHtml(displayName) + "</div>" +
            '<div class="od-job-url" title="' + escapeHtml(job.sanitized_url || "") + '">' + escapeHtml(job.sanitized_url || "—") + "</div>" +
            '<div class="row-wrap" style="gap:4px;margin-top:3px;">' +
              '<span class="badge">' + escapeHtml(job.provider_id || "generic_http") + "</span>" +
              '<span class="badge">' + escapeHtml(job.pacing_mode || "adaptive") + "</span>" +
              (job.sha256_actual ? '<span class="badge badge-emerald" title="' + escapeHtml(job.sha256_actual) + '">SHA-256 ✓</span>' : "") +
            "</div>" +
          "</td>" +
          "<td>" +
            '<div class="stack-xs">' +
              '<span class="badge ' + statusBadgeClass(statusLow) + '">' + escapeHtml(status) + "</span>" +
              (errorCode ? '<span class="mono" style="font-size:10px;color:var(--status-coral);">' + escapeHtml(errorCode) + "</span>" : "") +
              (job.error_message ? '<span class="mono muted" style="font-size:10px;max-width:170px;overflow-wrap:anywhere;">' + escapeHtml(job.error_message) + "</span>" : "") +
            "</div>" +
          "</td>" +
          "<td>" +
            '<div class="od-progress-wrap">' +
              '<div class="od-progress-track" role="progressbar" aria-label="Download progress for ' + escapeHtml(displayName) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(pct) + '">' +
                '<div class="od-progress-fill ' + progressFillClass(statusLow) + '" style="width:' + pct.toFixed(1) + '%;"></div>' +
              "</div>" +
              '<div class="row-between mono muted" style="font-size:10.5px;">' +
                "<span>" + pct.toFixed(1) + "%</span>" +
                "<span>" + escapeHtml(formatSize(downloadedBytes)) + " / " + escapeHtml(totalBytes > 0 ? formatSize(totalBytes) : "?") + "</span>" +
              "</div>" +
            "</div>" +
          "</td>" +
          '<td class="mono">' +
            "<div>" + escapeHtml(formatSpeed(speedBps)) + "</div>" +
            '<div class="muted" style="font-size:10.5px;">' + escapeHtml(String(activeStreams)) + " streams</div>" +
          "</td>" +
          '<td class="mono">' + escapeHtml(formatEta(etaSecs)) + "</td>" +
          "<td>" +
            '<div class="row-wrap" style="gap:4px;">' +
              '<button type="button" class="btn btn-subtle btn-xs" data-od-segments="' + escapeHtml(id) + '" aria-expanded="' + String(isExpanded) + '">Segments</button>' +
              '<button type="button" class="btn btn-xs" data-od-pause="' + escapeHtml(id) + '"' + (canPause ? "" : " disabled") + ">Pause</button>" +
              '<button type="button" class="btn btn-danger btn-xs" data-od-cancel="' + escapeHtml(id) + '"' + (canCancel ? "" : " disabled") + ">Cancel</button>" +
            "</div>" +
          "</td>" +
        "</tr>" +
        '<tr class="od-chunk-row" data-od-chunk-row="' + escapeHtml(id) + '">' +
          '<td colspan="6">' +
            '<div class="od-chunk-map-head">' +
              "<span>128-Cell Chunk Map · " + escapeHtml(id.slice(0, 14)) + " · " + escapeHtml(mapSourceLabel) + "</span>" +
              "<span>" + pct.toFixed(1) + "%</span>" +
            "</div>" +
            '<div class="od-chunk-grid" role="img" aria-label="128-cell chunk map for ' + escapeHtml(displayName) + ": " + pct.toFixed(1) + '% complete">' +
              cellSpans +
            "</div>" +
            segDetailHtml +
          "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderHandoffs() {
    const listEl = document.getElementById("odHandoffsList");
    const countEl = document.getElementById("odHandoffsCountBadge");
    if (!listEl) return;

    showErrorBanner("odHandoffsError", state.handoffsError ? state.handoffsError.code : null, state.handoffsError ? state.handoffsError.message : null);
    if (countEl) countEl.textContent = state.handoffs.length + " tickets";

    if (state.handoffsError && state.handoffs.length === 0) {
      listEl.innerHTML = '<div class="muted mono" style="font-size:11px;">Handoff endpoint unavailable.</div>';
      return;
    }
    if (state.handoffs.length === 0) {
      listEl.innerHTML = '<div class="muted mono" style="font-size:11px;">No visible-browser handoff tickets active. Automated CAPTCHA solving and DRM bypass remain strictly disabled.</div>';
      return;
    }

    listEl.innerHTML = state.handoffs.map((t) => {
      const refused = String(t.status || "").toLowerCase() === "refused_policy";
      return (
        '<article class="od-ticket-card ' + (refused ? "is-refused" : "") + '">' +
          '<div class="row-between">' +
            '<span class="badge ' + (refused ? "badge-coral" : "badge-amber") + '">' + escapeHtml(t.reason || "HANDOFF") + "</span>" +
            '<span class="badge">' + escapeHtml(t.status || "pending_user_action") + "</span>" +
          "</div>" +
          '<div class="mono" style="font-size:11px;overflow-wrap:anywhere;">' + escapeHtml(t.sanitized_url || "—") + "</div>" +
          '<div style="font-size:11.5px;color:var(--ink-secondary);line-height:1.4;">' + escapeHtml(t.guidance || "") + "</div>" +
          '<div class="mono muted" style="font-size:10px;">mode=' + escapeHtml(t.execution_mode || "MANUAL_VISIBLE_BROWSER_ONLY") +
            " · auto_solve=" + escapeHtml(String(Boolean(t.auto_solve_permitted))) +
            " · drm_supported=" + escapeHtml(String(Boolean(t.drm_supported))) +
          "</div>" +
        "</article>"
      );
    }).join("");
  }

  function renderProviders() {
    const catEl = document.getElementById("odProviderCategories");
    const gridEl = document.getElementById("odProvidersGrid");
    const countEl = document.getElementById("odProvidersCountBadge");
    if (!gridEl) return;

    showErrorBanner("odProvidersError", state.providersError ? state.providersError.code : null, state.providersError ? state.providersError.message : null);
    if (countEl) countEl.textContent = state.providers.length + " providers";

    if (catEl) {
      const cats = ["all"].concat(state.categories);
      catEl.innerHTML = cats.map((cat) => {
        const active = state.activeCategory === cat;
        const label = cat === "all" ? "All (" + state.providers.length + ")" : cat.replace(/_/g, " ");
        return '<button type="button" class="segmented-btn" aria-pressed="' + String(active) + '" data-od-cat="' + escapeHtml(cat) + '">' + escapeHtml(label) + "</button>";
      }).join("");
    }

    if (state.providersError && state.providers.length === 0) {
      gridEl.innerHTML = '<div class="muted mono" style="font-size:11px;">Provider registry unavailable.</div>';
      return;
    }

    const filtered = state.activeCategory === "all"
      ? state.providers
      : state.providers.filter((p) => String(p.category || "") === state.activeCategory);

    if (filtered.length === 0) {
      gridEl.innerHTML = '<div class="muted mono" style="font-size:11px;">No providers match this category.</div>';
      return;
    }

    gridEl.innerHTML = filtered.map((p) => (
      '<article class="od-provider-card">' +
        '<div class="row-between">' +
          '<strong style="font-size:12px;">' + escapeHtml(p.name || p.id) + "</strong>" +
          '<span class="badge badge-cyan">' + escapeHtml(String(p.default_streams || 1)) + "x</span>" +
        "</div>" +
        '<div class="row-wrap" style="gap:4px;">' +
          '<span class="badge">' + escapeHtml(p.category || "direct_http") + "</span>" +
          '<span class="badge ' + (p.supports_ranges ? "badge-emerald" : "badge-amber") + '">' + (p.supports_ranges ? "Range 206" : "Single") + "</span>" +
          '<span class="badge">' + escapeHtml(p.pacing_mode || "adaptive") + "</span>" +
        "</div>" +
        '<div class="mono muted" style="font-size:10px;overflow-wrap:anywhere;">' +
          escapeHtml(Array.isArray(p.host_patterns) ? p.host_patterns.join(", ") : "") +
        "</div>" +
      "</article>"
    )).join("");
  }

  function applyJobsSnapshot(jobsList) {
    if (!Array.isArray(jobsList)) return;
    const seen = new Set();
    const order = [];
    for (const job of jobsList) {
      if (!job || !job.job_id) continue;
      state.jobsById.set(job.job_id, job);
      if (!seen.has(job.job_id)) {
        seen.add(job.job_id);
        order.push(job.job_id);
      }
    }
    state.jobsOrder = order;
    state.jobsError = null;
    renderJobsTable();

    // Fetch segment details for jobs that do not yet have live SSE completed_ranges
    for (const job of jobsList) {
      if (!job || !job.job_id) continue;
      if (!state.segmentsById.has(job.job_id) && !state.liveById.has(job.job_id)) {
        fetchSegmentsForJob(job.job_id);
      }
    }
  }

  async function fetchSegmentsForJob(jobId) {
    const res = await Studio.api.getDownloadSegments(jobId);
    if (res && res.ok && Array.isArray(res.segments)) {
      state.segmentsById.set(jobId, res.segments);
      renderJobsTable();
    }
  }

  async function hydrateJob(jobId) {
    if (state.hydratedJobIds.has(jobId)) return;
    state.hydratedJobIds.add(jobId);
    try {
      const res = await Studio.api.getDownload(jobId);
      if (res && res.ok && res.job && res.job.job_id) {
        state.jobsById.set(res.job.job_id, res.job);
        if (!state.jobsOrder.includes(res.job.job_id)) {
          state.jobsOrder.unshift(res.job.job_id);
        }
        renderJobsTable();
      }
    } finally {
      state.hydratedJobIds.delete(jobId);
    }
  }

  function handleProgressEvent(ev) {
    if (!ev || !ev.job_id) return;
    const id = ev.job_id;
    state.liveById.set(id, ev);

    const existing = state.jobsById.get(id);
    if (existing) {
      existing.status = ev.status || existing.status;
      if (ev.downloaded_bytes != null) existing.downloaded_bytes = ev.downloaded_bytes;
      if (ev.total_bytes != null) existing.total_bytes = ev.total_bytes;
      if (ev.error_code != null) existing.error_code = ev.error_code;
      state.jobsById.set(id, existing);
    } else {
      state.jobsById.set(id, {
        job_id: id,
        sanitized_url: "",
        provider_id: "pending",
        destination_path: id,
        total_bytes: Number(ev.total_bytes || 0),
        downloaded_bytes: Number(ev.downloaded_bytes || 0),
        status: ev.status || "downloading",
        pacing_mode: state.pacingMode,
        streams: Number(ev.active_streams || 1),
        error_code: ev.error_code || null
      });
      if (!state.jobsOrder.includes(id)) {
        state.jobsOrder.unshift(id);
      }
      hydrateJob(id);
    }

    const st = String(ev.status || "").toLowerCase();
    if (st === "completed" || st === "failed" || st === "blocked_policy" || st === "awaiting_manual_handoff") {
      hydrateJob(id);
      refreshHandoffs();
    }
    renderJobsTable();
  }

  function disconnectEvents() {
    if (state.sse) {
      try {
        state.sse.close();
      } catch (_e) {
        // Ignore close errors
      }
      state.sse = null;
    }
    updateSseBadge("standby");
  }

  function connectEvents() {
    if (!Studio.api.canAttemptHttp() || typeof global.EventSource !== "function") {
      updateSseBadge("error", "EventSource unavailable outside HTTP origin.");
      return;
    }
    if (state.sse && state.sse.readyState !== 2) {
      return;
    }
    disconnectEvents();
    updateSseBadge("connecting");

    try {
      const es = new global.EventSource("/api/downloads/events");
      state.sse = es;

      es.addEventListener("open", () => {
        updateSseBadge("live");
      });

      es.addEventListener("snapshot", (event) => {
        updateSseBadge("live");
        try {
          const parsed = JSON.parse(event.data || "{}");
          if (Array.isArray(parsed.jobs)) {
            applyJobsSnapshot(parsed.jobs);
          }
        } catch (_err) {
          // Ignore malformed keepalive payload
        }
      });

      es.addEventListener("progress", (event) => {
        updateSseBadge("live");
        try {
          const parsed = JSON.parse(event.data || "{}");
          handleProgressEvent(parsed);
        } catch (_err) {
          // Ignore malformed event payload
        }
      });

      es.addEventListener("error", () => {
        if (es.readyState === 2) {
          updateSseBadge("error", "EventSource closed by host.");
        } else {
          updateSseBadge("connecting", "Reconnecting to /api/downloads/events…");
        }
      });
    } catch (err) {
      updateSseBadge("error", err && err.message ? err.message : "Failed to initialize EventSource.");
    }
  }

  async function refreshJobs() {
    const res = await Studio.api.listDownloads();
    if (!res || !res.ok) {
      state.jobsError = {
        code: (res && res.code) || "downloads_list_unavailable",
        message: (res && res.message) || "GET /api/downloads/list failed."
      };
      renderJobsTable();
      return;
    }
    applyJobsSnapshot(Array.isArray(res.jobs) ? res.jobs : []);
  }

  async function refreshHandoffs() {
    const res = await Studio.api.getOmniDriveHandoffs();
    if (!res || !res.ok) {
      state.handoffsError = {
        code: (res && res.code) || "handoffs_unavailable",
        message: (res && res.message) || "GET /api/omni-drive/handoffs failed."
      };
      state.handoffs = [];
      renderHandoffs();
      return;
    }
    state.handoffsError = null;
    state.handoffs = Array.isArray(res.tickets) ? res.tickets : [];
    renderHandoffs();
  }

  async function refreshProviders() {
    const res = await Studio.api.getOmniDriveProviders();
    if (!res || !res.ok) {
      state.providersError = {
        code: (res && res.code) || "providers_unavailable",
        message: (res && res.message) || "GET /api/omni-drive/providers failed."
      };
      state.providers = [];
      state.categories = [];
      renderProviders();
      return;
    }
    state.providersError = null;
    state.providers = Array.isArray(res.providers) ? res.providers : [];
    state.categories = Array.isArray(res.categories) ? res.categories : [];
    renderProviders();
  }

  async function refreshAll() {
    await Promise.all([refreshJobs(), refreshHandoffs(), refreshProviders()]);
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

  function bindEvents() {
    const streamsRange = document.getElementById("odStreamsRange");
    const streamsInput = document.getElementById("odStreamsInput");
    const updateStreams = (val) => {
      const n = Math.max(1, Math.min(128, Math.trunc(Number(val) || 1)));
      state.streams = n;
      if (streamsRange) streamsRange.value = String(n);
      if (streamsInput) streamsInput.value = String(n);
      syncPacingUi();
    };
    if (streamsRange) streamsRange.addEventListener("input", () => updateStreams(streamsRange.value));
    if (streamsInput) streamsInput.addEventListener("change", () => updateStreams(streamsInput.value));

    const pacingGroup = document.getElementById("odPacingGroup");
    if (pacingGroup) {
      const pickPacing = (btn) => {
        const mode = btn.getAttribute("data-od-pacing");
        if (!mode) return;
        state.pacingMode = mode;
        syncPacingUi();
      };
      pacingGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-od-pacing]");
        if (btn) pickPacing(btn);
      });
      bindRadiogroupKeyboard(pacingGroup, "[data-od-pacing]", pickPacing);
    }

    const probeBtn = document.getElementById("btnOdProbe");
    if (probeBtn) {
      probeBtn.addEventListener("click", async () => {
        const urlEl = document.getElementById("odUrlInput");
        const url = urlEl ? urlEl.value.trim() : "";
        if (!url) {
          showFeedbackBanner("odFormFeedback", "error", "invalid_input", "Enter a target URL before probing.");
          return;
        }
        probeBtn.disabled = true;
        showFeedbackBanner("odFormFeedback", "info", "Probing", "Issuing POST /api/downloads/probe…");
        try {
          const res = await Studio.api.probeDownload(url);
          if (!res || !res.ok || !res.probe) {
            renderProbeOrResource(null, null);
            showFeedbackBanner("odFormFeedback", "error", (res && res.code) || "probe_failed", (res && res.message) || "Probe failed.");
            refreshHandoffs();
            return;
          }
          showFeedbackBanner("odFormFeedback", null, null, null);
          renderProbeOrResource("probe", res.probe);
        } finally {
          probeBtn.disabled = false;
        }
      });
    }

    const resolveBtn = document.getElementById("btnOdResolveDrive");
    if (resolveBtn) {
      resolveBtn.addEventListener("click", async () => {
        const urlEl = document.getElementById("odUrlInput");
        const url = urlEl ? urlEl.value.trim() : "";
        if (!url) {
          showFeedbackBanner("odFormFeedback", "error", "invalid_input", "Enter a Google Drive or Docs URL to resolve.");
          return;
        }
        resolveBtn.disabled = true;
        showFeedbackBanner("odFormFeedback", "info", "Resolving", "Issuing POST /api/omni-drive/resolve…");
        try {
          const res = await Studio.api.resolveOmniDrive(url);
          if (!res || !res.ok || !res.resource) {
            renderProbeOrResource(null, null);
            showFeedbackBanner("odFormFeedback", "error", (res && res.code) || "resolve_failed", (res && res.message) || "Drive URL resolution failed.");
            return;
          }
          showFeedbackBanner("odFormFeedback", null, null, null);
          renderProbeOrResource("drive", res.resource);
        } finally {
          resolveBtn.disabled = false;
        }
      });
    }

    const probeResultEl = document.getElementById("odProbeResult");
    if (probeResultEl) {
      probeResultEl.addEventListener("click", (e) => {
        const fillName = e.target.closest("[data-od-fill-filename]");
        if (fillName) {
          const fnEl = document.getElementById("odFilenameInput");
          if (fnEl) fnEl.value = fillName.getAttribute("data-od-fill-filename") || "";
          return;
        }
        const fillFolder = e.target.closest("[data-od-fill-folder]");
        if (fillFolder) {
          const fldEl = document.getElementById("odFolderInput");
          if (fldEl) fldEl.value = fillFolder.getAttribute("data-od-fill-folder") || "";
        }
      });
    }

    const startForm = document.getElementById("odStartForm");
    if (startForm) {
      startForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const url = (document.getElementById("odUrlInput") || {}).value || "";
        const filename = (document.getElementById("odFilenameInput") || {}).value || "";
        const speedLimitRaw = (document.getElementById("odSpeedLimitInput") || {}).value || "";
        const expectedSha = (document.getElementById("odExpectedShaInput") || {}).value || "";
        if (!url.trim()) {
          showFeedbackBanner("odFormFeedback", "error", "invalid_input", "Target URL is required.");
          return;
        }
        const payload = {
          url: url.trim(),
          streams: state.streams,
          pacing_mode: state.pacingMode
        };
        if (filename.trim()) payload.filename = filename.trim();
        if (speedLimitRaw.trim() && Number(speedLimitRaw) > 0) {
          payload.speed_limit_bps = Math.trunc(Number(speedLimitRaw));
        }
        if (expectedSha.trim()) payload.expected_sha256 = expectedSha.trim();

        const submitBtn = document.getElementById("btnOdStartDownload");
        if (submitBtn) submitBtn.disabled = true;
        showFeedbackBanner("odFormFeedback", "info", "Starting", "Issuing POST /api/downloads/start…");
        try {
          const res = await Studio.api.startDownload(payload);
          if (!res || !res.ok) {
            showFeedbackBanner("odFormFeedback", "error", (res && res.code) || "start_failed", (res && res.message) || "Download launch rejected.");
            refreshHandoffs();
            return;
          }
          showFeedbackBanner("odFormFeedback", "success", "QUEUED", "Started job " + String(res.job_id || ""));
          connectEvents();
          await refreshJobs();
          if (res.job_id) fetchSegmentsForJob(res.job_id);
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }

    const jobsBody = document.getElementById("odJobsTableBody");
    if (jobsBody) {
      jobsBody.addEventListener("click", async (e) => {
        const segBtn = e.target.closest("[data-od-segments]");
        if (segBtn) {
          const jobId = segBtn.getAttribute("data-od-segments");
          if (!jobId) return;
          if (state.expandedJobIds.has(jobId)) {
            state.expandedJobIds.delete(jobId);
            renderJobsTable();
          } else {
            state.expandedJobIds.add(jobId);
            renderJobsTable();
            await fetchSegmentsForJob(jobId);
          }
          return;
        }

        const pauseBtn = e.target.closest("[data-od-pause]");
        if (pauseBtn) {
          const jobId = pauseBtn.getAttribute("data-od-pause");
          if (!jobId) return;
          pauseBtn.disabled = true;
          const res = await Studio.api.pauseDownload(jobId);
          if (!res || !res.ok) {
            showErrorBanner("odJobsError", (res && res.code) || "pause_failed", (res && res.message) || "Failed to pause job.");
          }
          await refreshJobs();
          return;
        }

        const cancelBtn = e.target.closest("[data-od-cancel]");
        if (cancelBtn) {
          const jobId = cancelBtn.getAttribute("data-od-cancel");
          if (!jobId) return;
          cancelBtn.disabled = true;
          const res = await Studio.api.cancelDownload(jobId);
          if (!res || !res.ok) {
            showErrorBanner("odJobsError", (res && res.code) || "cancel_failed", (res && res.message) || "Failed to cancel job.");
          }
          await refreshJobs();
        }
      });
    }

    const catGroup = document.getElementById("odProviderCategories");
    if (catGroup) {
      catGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-od-cat]");
        if (!btn) return;
        state.activeCategory = btn.getAttribute("data-od-cat") || "all";
        renderProviders();
      });
    }

    const refreshBtn = document.getElementById("btnOdRefreshAll");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        connectEvents();
        refreshAll();
      });
    }

    const batchForm = document.getElementById("odBatchForm");
    if (batchForm) {
      batchForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const pattern = (document.getElementById("odBatchPatternInput") || {}).value || "";
        const outEl = document.getElementById("odBatchOutput");
        if (!outEl) return;
        const res = await Studio.api.expandOmniDriveBatch(pattern);
        outEl.hidden = false;
        if (!res || !res.ok) {
          outEl.innerHTML = '<div class="studio-error-banner"><span class="studio-error-code">' +
            escapeHtml((res && res.code) || "batch_expand_failed") + "</span><span>" +
            escapeHtml((res && res.message) || "Batch expansion failed.") + "</span></div>";
          return;
        }
        const urls = Array.isArray(res.urls) ? res.urls : [];
        outEl.innerHTML =
          '<div class="mono muted" style="font-size:10.5px;">Expanded ' + urls.length + " URLs:</div>" +
          '<pre class="code-pre" style="max-height:110px;padding:6px;">' + escapeHtml(urls.join("\n")) + "</pre>";
      });
    }

    const folderForm = document.getElementById("odFolderForm");
    if (folderForm) {
      folderForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = ((document.getElementById("odFolderInput") || {}).value || "").trim();
        const depthRaw = Number((document.getElementById("odFolderDepthInput") || {}).value);
        const outEl = document.getElementById("odFolderOutput");
        if (!outEl || !input) return;
        const payload = input.includes("://") || input.includes("/")
          ? { url: input }
          : { folder_id: input };
        if (Number.isFinite(depthRaw) && depthRaw >= 0) payload.max_depth = Math.trunc(depthRaw);
        const res = await Studio.api.planOmniDriveFolder(payload);
        outEl.hidden = false;
        if (!res || !res.ok || !res.plan) {
          outEl.innerHTML = '<div class="studio-error-banner"><span class="studio-error-code">' +
            escapeHtml((res && res.code) || "plan_folder_failed") + "</span><span>" +
            escapeHtml((res && res.message) || "Folder planning failed.") + "</span></div>";
          return;
        }
        const items = Array.isArray(res.plan.items) ? res.plan.items : [];
        outEl.innerHTML =
          '<div class="mono" style="font-size:10.5px;">Plan ' + escapeHtml(res.plan.plan_id || "") +
          " · " + items.length + " items · drm_supported=" + escapeHtml(String(Boolean(res.plan.drm_supported))) + "</div>" +
          (items.length
            ? '<pre class="code-pre" style="max-height:120px;padding:6px;">' +
                escapeHtml(items.map((it) => (it.filename || it.url)).join("\n")) +
              "</pre>"
            : '<div class="mono muted" style="font-size:10.5px;">0 downloadable items returned.</div>');
      });
    }

    const mediaForm = document.getElementById("odMediaForm");
    if (mediaForm) {
      mediaForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const b64 = ((document.getElementById("odMediaBase64Input") || {}).value || "").trim();
        const outEl = document.getElementById("odMediaOutput");
        if (!outEl || !b64) return;
        const res = await Studio.api.inspectOmniDriveMedia(b64);
        outEl.hidden = false;
        if (!res || !res.ok || !res.report) {
          outEl.innerHTML = '<div class="studio-error-banner"><span class="studio-error-code">' +
            escapeHtml((res && res.code) || "inspect_media_failed") + "</span><span>" +
            escapeHtml((res && res.message) || "Media inspection failed.") + "</span></div>";
          return;
        }
        const r = res.report;
        outEl.innerHTML =
          '<div class="od-kv-grid">' +
            '<span class="od-kv-key">Format</span><span class="od-kv-val">' + escapeHtml(String(r.format || "unknown")) + "</span>" +
            '<span class="od-kv-key">Bytes</span><span class="od-kv-val">' + escapeHtml(String(r.bytes_inspected || 0)) + "</span>" +
            '<span class="od-kv-key">DRM Detected</span><span class="od-kv-val">' + escapeHtml(String(Boolean(r.drm_detected))) + " (pssh=" + escapeHtml(String(Boolean(r.has_pssh))) + ")</span>" +
            '<span class="od-kv-key">DRM Supported</span><span class="od-kv-val">' + escapeHtml(String(Boolean(r.drm_supported))) + "</span>" +
          "</div>";
      });
    }
  }

  async function init() {
    syncPacingUi();
    bindEvents();
    await refreshAll();
  }

  function onActivate() {
    connectEvents();
    refreshAll();
  }

  function onDeactivate() {
    disconnectEvents();
  }

  Studio.omnidrive = {
    init,
    onActivate,
    onDeactivate,
    refreshAll,
    connectEvents,
    disconnectEvents,
    compute128CellFractions
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
