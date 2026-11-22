"use strict";

(function initRouterLabModule(global) {
  const Studio = (global.OmniaStudio = global.OmniaStudio || {});
  const { escapeHtml } = Studio.utils;

  const routerState = {
    candidates: [],
    lastDecision: null,
    state: "unknown",
    error: null
  };

  function getPolicyInputs() {
    const taskEl = document.getElementById("routerTaskClass");
    const tokEl = document.getElementById("routerEstimatedTokens");
    const privEl = document.getElementById("routerPrivacyTier");
    const streamEl = document.getElementById("routerRequireStreaming");
    return {
      taskClass: taskEl ? taskEl.value : "code_generation",
      estimatedTokens: tokEl ? Number(tokEl.value) : 8192,
      privacyTier: privEl ? privEl.value : "enterprise_zdr",
      requireStreaming: streamEl ? Boolean(streamEl.checked) : true
    };
  }

  function circuitBadge(circuit) {
    const c = String(circuit || "Unknown");
    if (c === "Closed") return '<span class="badge badge-emerald">◆ Closed</span>';
    if (c === "HalfOpen" || c === "half_open") return '<span class="badge badge-amber">▲ HalfOpen</span>';
    if (c === "Unknown") return '<span class="badge badge-coral">■ Circuit: Unknown</span>';
    return '<span class="badge badge-coral">■ Open</span>';
  }

  function quotaBadge(qState, remTokens) {
    const q = String(qState || "Unknown");
    if (q === "Known") {
      const rem = Number(remTokens);
      return '<span class="badge badge-emerald">Quota: Known (' +
        escapeHtml(Number.isFinite(rem) ? rem.toLocaleString() : "remaining unavailable") + " tok)</span>";
    }
    if (q === "Stale") {
      return '<span class="badge badge-amber">Quota: Stale (TTL Expired • Never Coerced)</span>';
    }
    if (q === "Contradictory") {
      return '<span class="badge badge-coral">Quota: Contradictory</span>';
    }
    return '<span class="badge badge-coral">Quota: Unknown (Explicit Null • Never 0)</span>';
  }

  function renderRouterWorkbench() {
    const summaryEl = document.getElementById("routerDecisionBanner");
    const listEl = document.getElementById("routerCandidateMatrix");
    const receiptPre = document.getElementById("routerReceiptJson");
    if (!listEl) return;

    const decision = routerState.lastDecision;
    const selectedId = decision ? decision.selectedCandidateId : null;
    const scoreMap = new Map();
    if (decision && decision.receipt && Array.isArray(decision.receipt.scores)) {
      for (const s of decision.receipt.scores) {
        scoreMap.set(s.candidateId || s.candidate_id, s);
      }
    }

    if (summaryEl && routerState.state === "unavailable") {
      summaryEl.innerHTML =
        '<div class="row-between">' +
          '<span class="badge badge-coral">ROUTER UNAVAILABLE</span>' +
          '<span class="mono muted" style="font-size:11px;">' +
            escapeHtml(routerState.error || "router_endpoint_unavailable") +
          "</span>" +
        "</div>";
    } else if (summaryEl && decision) {
      const ok = Boolean(selectedId);
      summaryEl.innerHTML =
        '<div class="row-between">' +
          '<div class="row-wrap">' +
            '<span class="badge ' + (ok ? "badge-emerald" : "badge-coral") + '">' +
              escapeHtml(decision.status || (ok ? "ROUTED" : "FENCED")) +
            "</span>" +
            '<strong>' + escapeHtml(selectedId ? ("Selected Route: " + selectedId) : "All Candidates Fenced — Operator Recovery Required") + "</strong>" +
          "</div>" +
          '<span class="mono muted" style="font-size:11px;">' +
            escapeHtml(decision.receipt ? (decision.receipt.receiptId + " • " + decision.receipt.policyHash) : "") +
          "</span>" +
        "</div>";
    }

    if (routerState.state === "unavailable") {
      listEl.innerHTML = '<div class="muted" style="padding:10px 0;">' +
        escapeHtml(routerState.error || "router_state_endpoint_unavailable") + "</div>";
      if (receiptPre) receiptPre.textContent = "";
      return;
    }
    if (routerState.candidates.length === 0) {
      listEl.innerHTML = '<div class="muted" style="padding:10px 0;">Live router returned no candidates.</div>';
      if (receiptPre) receiptPre.textContent = decision && decision.receipt
        ? JSON.stringify(decision.receipt, null, 2)
        : "";
      return;
    }

    listEl.innerHTML = routerState.candidates.map((cand) => {
      const sc = scoreMap.get(cand.id) || null;
      const isWinner = cand.id === selectedId;
      const quotaPct = cand.quotaState === "Known" && typeof cand.remainingTokens === "number" && Number.isFinite(cand.remainingTokens)
        ? Math.min(100, Math.max(4, Math.round((cand.remainingTokens / 1000000) * 100)))
        : 0;
      const latPct = typeof cand.p95Ms === "number" && Number.isFinite(cand.p95Ms)
        ? Math.min(100, Math.max(5, Math.round((cand.p95Ms / 1800) * 100)))
        : 0;
      const scoreValue = (key) => sc && sc[key] !== undefined && sc[key] !== null
        ? escapeHtml(sc[key])
        : "—";
      const p95Text = typeof cand.p95Ms === "number" && Number.isFinite(cand.p95Ms)
        ? escapeHtml(cand.p95Ms) + " ms"
        : "p95 unavailable";
      const errorText = typeof cand.errorRate === "number" && Number.isFinite(cand.errorRate)
        ? (cand.errorRate * 100).toFixed(1) + "%"
        : "error rate unavailable";
      const circuitAction = cand.circuit === "Open"
        ? '<button type="button" class="btn btn-subtle" style="min-height:28px;padding:0 8px;" data-reset-cand="' + escapeHtml(cand.id) + '">Reset Circuit</button>'
        : (cand.circuit === "Closed" || cand.circuit === "HalfOpen" || cand.circuit === "half_open"
          ? '<button type="button" class="btn btn-danger" style="min-height:28px;padding:0 8px;" data-trip-cand="' + escapeHtml(cand.id) + '">Trip Circuit</button>'
          : '<span class="mono muted" style="font-size:10.5px;">Circuit action unavailable</span>');
      const waterfallTrack = sc
        ? '<div class="waterfall-track" title="Capability / Privacy / Quota / Latency / Reliability">' +
            '<div class="wf-seg-cap" style="width:' + Math.max(0, Number(sc.capabilityScore) || 0) + '%"></div>' +
            '<div class="wf-seg-priv" style="width:' + Math.max(0, Number(sc.privacyScore) || 0) + '%"></div>' +
            '<div class="wf-seg-quota" style="width:' + Math.max(0, Number(sc.quotaScore) || 0) + '%"></div>' +
            '<div class="wf-seg-lat" style="width:' + Math.max(0, Number(sc.latencyScore) || 0) + '%"></div>' +
            '<div class="wf-seg-rel" style="width:' + Math.max(0, Number(sc.reliabilityScore) || 0) + '%"></div>' +
          "</div>"
        : '<div class="mono muted" style="font-size:11px;">Score segments unavailable until a live decision receipt is returned.</div>';

      return (
        '<div class="candidate-row ' + (isWinner ? "is-selected" : "") + '" id="router-cand-' + escapeHtml(cand.id) + '">' +
          '<div class="row-between">' +
            '<div class="row-wrap">' +
              '<strong>' + escapeHtml(cand.id) + '</strong>' +
              '<span class="mono muted" style="font-size:11px;">' + escapeHtml(cand.providerId + " / " + cand.modelId) + "</span>" +
              (isWinner ? '<span class="badge badge-amber">★ SELECTED WINNER</span>' : "") +
            "</div>" +
            '<div class="row-wrap">' +
              circuitBadge(cand.circuit) +
              quotaBadge(cand.quotaState, cand.remainingTokens) +
              circuitAction +
            "</div>" +
          "</div>" +

          '<div class="row-between mono" style="font-size:11px;">' +
              '<span>Score Waterfall: <strong>' + scoreValue("totalScore") + " / 100</strong> " +
              "(Cap " + scoreValue("capabilityScore") +
              " + Priv " + scoreValue("privacyScore") +
              " + Quota " + scoreValue("quotaScore") +
              " + Lat " + scoreValue("latencyScore") +
              " + Rel " + scoreValue("reliabilityScore") + ")</span>" +
            '<span class="muted">Privacy: ' + escapeHtml(cand.privacyTier) +
              " • EWMA " + escapeHtml(cand.ewmaMs ?? "unavailable") + "ms • p95 " + p95Text + "</span>" +
          "</div>" +

          waterfallTrack +

          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
            '<div class="stack-xs">' +
              '<div class="row-between mono muted" style="font-size:10.5px;">' +
                '<span>Remaining Budget Meter</span>' +
                '<span>' + (cand.quotaState === "Known" && Number.isFinite(Number(cand.reserveTokens))
                  ? ("Reserve " + escapeHtml(Number(cand.reserveTokens).toLocaleString()) + " tok")
                  : escapeHtml(cand.quotaState || "quota unavailable")) + "</span>" +
              "</div>" +
              '<div class="meter-bar"><div class="meter-fill" style="width:' + quotaPct + '%;background:' + (cand.quotaState === "Known" ? "var(--status-emerald)" : "var(--status-coral)") + ';"></div></div>' +
            "</div>" +
            '<div class="stack-xs">' +
              '<div class="row-between mono muted" style="font-size:10.5px;">' +
                '<span>p95 Tail Latency</span>' +
                '<span>' + p95Text + " (err " + escapeHtml(errorText) + ")</span>" +
              "</div>" +
              '<div class="meter-bar"><div class="meter-fill" style="width:' + latPct + '%;background:' + (cand.p95Ms > 800 ? "var(--status-coral)" : "var(--accent-cyan)") + ';"></div></div>' +
            "</div>" +
          "</div>" +

          (sc && sc.rejectedReason
            ? '<div class="mono" style="font-size:11px;color:var(--status-coral);">✕ Fenced / Rejected: ' + escapeHtml(sc.rejectedReason) + "</div>"
            : (sc && typeof sc.eligible === "boolean"
              ? '<div class="mono" style="font-size:11px;color:' + (sc.eligible ? "var(--status-emerald)" : "var(--status-coral)") + ';">' +
                (sc.eligible ? "✓ Eligible • Decision receipt confirmed" : "✕ Ineligible • Decision receipt confirmed") + "</div>"
              : '<div class="mono muted" style="font-size:11px;">Eligibility unavailable until a live decision receipt includes it.</div>')) +
        "</div>"
      );
    }).join("");

    if (receiptPre && decision && decision.receipt) {
      receiptPre.textContent = JSON.stringify(decision.receipt, null, 2);
    }
  }

  async function executeDecision(extraOverride) {
    const req = Object.assign(getPolicyInputs(), extraOverride || {});
    const res = await Studio.api.decideRoute(req);
    routerState.lastDecision = res;
    routerState.state = res && res.state ? res.state : (res && res.ok === false ? "unavailable" : "ok");
    routerState.error = res && res.error ? res.error : null;
    if (Array.isArray(res.candidates)) {
      routerState.candidates = res.candidates;
    } else if (routerState.state !== "unavailable") {
      const st = await Studio.api.getRouterState();
      routerState.candidates = st.candidates || [];
      routerState.state = st.state || (st.ok === false ? "unavailable" : "ok");
      routerState.error = st.error || null;
    } else {
      routerState.candidates = [];
    }
    renderRouterWorkbench();
  }

  async function init() {
    const st = await Studio.api.getRouterState();
    routerState.candidates = st.candidates || [];
    routerState.state = st.state || (st.ok === false ? "unavailable" : "ok");
    routerState.error = st.error || null;
    await executeDecision();

    const tokSlider = document.getElementById("routerEstimatedTokens");
    const tokLabel = document.getElementById("routerTokensReadout");
    if (tokSlider && tokLabel) {
      tokSlider.addEventListener("input", () => {
        tokLabel.textContent = Number(tokSlider.value).toLocaleString() + " tok";
      });
    }

    const form = document.getElementById("routerPolicyForm");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        executeDecision();
      });
    }

    const matrix = document.getElementById("routerCandidateMatrix");
    if (matrix) {
      matrix.addEventListener("click", (e) => {
        const trip = e.target.closest("[data-trip-cand]");
        if (trip) {
          executeDecision({ tripCandidate: trip.getAttribute("data-trip-cand") });
          return;
        }
        const reset = e.target.closest("[data-reset-cand]");
        if (reset) {
          executeDecision({ resetCandidate: reset.getAttribute("data-reset-cand") });
        }
      });
    }

    document.querySelectorAll("[data-router-scenario]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const sc = btn.getAttribute("data-router-scenario");
        const privEl = document.getElementById("routerPrivacyTier");
        const taskEl = document.getElementById("routerTaskClass");
        if (sc === "strict-local") {
          if (privEl) privEl.value = "strict_local_zero_retention";
          if (taskEl) taskEl.value = "code_generation";
          await executeDecision();
        } else if (sc === "trip-gemini") {
          if (privEl) privEl.value = "enterprise_zdr";
          await executeDecision({ tripCandidate: "google-gemini-3-1-pro" });
        } else if (sc === "reset-all") {
          if (privEl) privEl.value = "enterprise_zdr";
          const ids = routerState.candidates.length
            ? routerState.candidates.map((c) => c.id)
            : ["google-gemini-3-1-pro", "anthropic-opus-4-6", "local-rust-llama-q8"];
          for (const candId of ids) {
            await executeDecision({ resetCandidate: candId });
          }
        }
      });
    });
  }

  Studio.routerLab = {
    init,
    executeDecision,
    highlightCandidate(candId) {
      const el = document.getElementById("router-cand-" + candId);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
