"use strict";

(function initRouterLabModule(global) {
  const Studio = (global.OmniaStudio = global.OmniaStudio || {});
  const { escapeHtml } = Studio.utils;

  const routerState = {
    candidates: [],
    lastDecision: null
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
    const c = String(circuit || "Closed");
    if (c === "Closed") return '<span class="badge badge-emerald">◆ Closed</span>';
    if (c === "HalfOpen" || c === "half_open") return '<span class="badge badge-amber">▲ HalfOpen</span>';
    return '<span class="badge badge-coral">■ Open</span>';
  }

  function quotaBadge(qState, remTokens) {
    const q = String(qState || "Known");
    if (q === "Known") {
      return '<span class="badge badge-emerald">Quota: Known (' +
        escapeHtml((Number(remTokens) || 0).toLocaleString()) + " tok)</span>";
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

    if (summaryEl && decision) {
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

    listEl.innerHTML = routerState.candidates.map((cand) => {
      const sc = scoreMap.get(cand.id) || {
        eligible: cand.circuit === "Closed" && cand.quotaState === "Known",
        totalScore: 0,
        capabilityScore: 0,
        privacyScore: 0,
        quotaScore: 0,
        latencyScore: 0,
        reliabilityScore: 0,
        rejectedReason: null
      };
      const isWinner = cand.id === selectedId;
      const quotaPct = cand.quotaState === "Known" && typeof cand.remainingTokens === "number"
        ? Math.min(100, Math.max(4, Math.round((cand.remainingTokens / 1000000) * 100)))
        : 0;
      const latPct = Math.min(100, Math.max(5, Math.round(((cand.p95Ms || 300) / 1800) * 100)));

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
              (cand.circuit === "Open"
                ? '<button type="button" class="btn btn-subtle" style="min-height:28px;padding:0 8px;" data-reset-cand="' + escapeHtml(cand.id) + '">Reset Circuit</button>'
                : '<button type="button" class="btn btn-danger" style="min-height:28px;padding:0 8px;" data-trip-cand="' + escapeHtml(cand.id) + '">Trip Circuit</button>') +
            "</div>" +
          "</div>" +

          '<div class="row-between mono" style="font-size:11px;">' +
            '<span>Score Waterfall: <strong>' + escapeHtml(sc.totalScore) + " / 100</strong> " +
              "(Cap " + escapeHtml(sc.capabilityScore) +
              " + Priv " + escapeHtml(sc.privacyScore) +
              " + Quota " + escapeHtml(sc.quotaScore) +
              " + Lat " + escapeHtml(sc.latencyScore) +
              " + Rel " + escapeHtml(sc.reliabilityScore) + ")</span>" +
            '<span class="muted">Privacy: ' + escapeHtml(cand.privacyTier) +
              " • EWMA " + escapeHtml(cand.ewmaMs) + "ms • p95 " + escapeHtml(cand.p95Ms) + "ms</span>" +
          "</div>" +

          '<div class="waterfall-track" title="Capability / Privacy / Quota / Latency / Reliability">' +
            '<div class="wf-seg-cap" style="width:' + Math.max(0, sc.capabilityScore) + '%"></div>' +
            '<div class="wf-seg-priv" style="width:' + Math.max(0, sc.privacyScore) + '%"></div>' +
            '<div class="wf-seg-quota" style="width:' + Math.max(0, sc.quotaScore) + '%"></div>' +
            '<div class="wf-seg-lat" style="width:' + Math.max(0, sc.latencyScore) + '%"></div>' +
            '<div class="wf-seg-rel" style="width:' + Math.max(0, sc.reliabilityScore) + '%"></div>' +
          "</div>" +

          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
            '<div class="stack-xs">' +
              '<div class="row-between mono muted" style="font-size:10.5px;">' +
                '<span>Remaining Budget Meter</span>' +
                '<span>' + (cand.quotaState === "Known" ? ("Reserve " + escapeHtml((cand.reserveTokens || 0).toLocaleString()) + " tok") : escapeHtml(cand.quotaState)) + "</span>" +
              "</div>" +
              '<div class="meter-bar"><div class="meter-fill" style="width:' + quotaPct + '%;background:' + (cand.quotaState === "Known" ? "var(--status-emerald)" : "var(--status-coral)") + ';"></div></div>' +
            "</div>" +
            '<div class="stack-xs">' +
              '<div class="row-between mono muted" style="font-size:10.5px;">' +
                '<span>p95 Tail Latency</span>' +
                '<span>' + escapeHtml(cand.p95Ms) + " ms (err " + escapeHtml(((cand.errorRate || 0) * 100).toFixed(1)) + "%)</span>" +
              "</div>" +
              '<div class="meter-bar"><div class="meter-fill" style="width:' + latPct + '%;background:' + (cand.p95Ms > 800 ? "var(--status-coral)" : "var(--accent-cyan)") + ';"></div></div>' +
            "</div>" +
          "</div>" +

          (sc.rejectedReason
            ? '<div class="mono" style="font-size:11px;color:var(--status-coral);">✕ Fenced / Rejected: ' + escapeHtml(sc.rejectedReason) + "</div>"
            : '<div class="mono" style="font-size:11px;color:var(--status-emerald);">✓ Eligible • Atomic idempotent reservation ready</div>') +
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
    if (Array.isArray(res.candidates)) {
      routerState.candidates = res.candidates;
    } else {
      const st = await Studio.api.getRouterState();
      routerState.candidates = st.candidates || [];
    }
    renderRouterWorkbench();
  }

  async function init() {
    const st = await Studio.api.getRouterState();
    routerState.candidates = st.candidates || [];
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
          await executeDecision({ resetCandidate: "google-gemini-3-1-pro" });
          await executeDecision({ resetCandidate: "anthropic-opus-4-6" });
          await executeDecision({ resetCandidate: "local-cpp-llama-q8" });
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
