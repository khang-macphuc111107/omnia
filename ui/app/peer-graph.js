"use strict";

(function initPeerGraphModule(global) {
  const Studio = (global.OmniaStudio = global.OmniaStudio || {});
  const { escapeHtml } = Studio.utils;

  const graphState = {
    data: null,
    selectedNodeId: "ui-atelier",
    hoveredNodeId: null,
    layerMode: "peer-mesh", // "peer-mesh" | "graphify"
    traversalResult: null,
    nodePositions: new Map(),
    particles: [],
    animFrameId: null,
    reducedMotion: false
  };

  function cssVar(name, fallback) {
    if (typeof getComputedStyle === "undefined") return fallback;
    const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return val || fallback;
  }

  function seedAmbientParticles() {
    graphState.particles = [];
    if (!graphState.data || !Array.isArray(graphState.data.links)) return;
    graphState.data.links.forEach((lnk, idx) => {
      graphState.particles.push({
        from: lnk.from,
        to: lnk.to,
        t: (idx * 0.19) % 1,
        speed: 0.0032,
        reverse: false,
        burst: false
      });
      graphState.particles.push({
        from: lnk.to,
        to: lnk.from,
        t: ((idx * 0.31) + 0.5) % 1,
        speed: 0.0028,
        reverse: true,
        burst: false
      });
    });
  }

  function spawnPulseBurst(fromId, toId) {
    if (!graphState.data) return;
    if (toId === "@all") {
      for (const node of graphState.data.nodes) {
        if (node.id !== fromId) {
          graphState.particles.push({ from: fromId, to: node.id, t: 0, speed: 0.016, burst: true });
        }
      }
      return;
    }
    graphState.particles.push({ from: fromId, to: toId, t: 0, speed: 0.018, burst: true });
    graphState.particles.push({ from: toId, to: fromId, t: 0.12, speed: 0.015, burst: true });
  }

  function computeLayout(width, height) {
    graphState.nodePositions.clear();
    const cx = width * 0.5;
    const cy = height * 0.5;
    const rx = Math.max(120, Math.min(width * 0.36, 290));
    const ry = Math.max(95, Math.min(height * 0.35, 205));

    const nodes = graphState.layerMode === "peer-mesh"
      ? (graphState.data ? graphState.data.nodes : [])
      : (graphState.data ? graphState.data.graphifyNodes : []);

    if (!nodes.length) return;
    nodes.forEach((node, idx) => {
      if (idx === 0) {
        graphState.nodePositions.set(node.id, { x: cx, y: cy, r: 28, node });
      } else {
        const ringCount = nodes.length - 1;
        const angle = -Math.PI / 2 + ((idx - 1) * 2 * Math.PI) / ringCount;
        graphState.nodePositions.set(node.id, {
          x: cx + Math.cos(angle) * rx,
          y: cy + Math.sin(angle) * ry,
          r: 24,
          node
        });
      }
    });
  }

  function drawCurvedArc(ctx, p1, p2, curvature, strokeStyle, lineWidth, dashed) {
    const mx = (p1.x + p2.x) * 0.5;
    const my = (p1.y + p2.y) * 0.5;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const ctrlX = mx + nx * curvature;
    const ctrlY = my + ny * curvature;

    ctx.save();
    ctx.beginPath();
    if (dashed) ctx.setLineDash(dashed);
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.moveTo(p1.x, p1.y);
    ctx.quadraticCurveTo(ctrlX, ctrlY, p2.x, p2.y);
    ctx.stroke();
    ctx.restore();
    return { ctrlX, ctrlY };
  }

  function pointOnQuadBezier(p1, ctrl, p2, t) {
    const inv = 1 - t;
    return {
      x: inv * inv * p1.x + 2 * inv * t * ctrl.ctrlX + t * t * p2.x,
      y: inv * inv * p1.y + 2 * inv * t * ctrl.ctrlY + t * t * p2.y
    };
  }

  function renderCanvasFrame() {
    const canvas = document.getElementById("peerMeshCanvas");
    if (!canvas || !graphState.data) return;
    const rect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : { width: 640, height: 420 };
    const w = Math.max(300, Math.floor(rect.width));
    const h = Math.max(260, Math.floor(rect.height));
    const dpr = Math.min(2, global.devicePixelRatio || 1);

    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    computeLayout(w, h);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // Subtle CAD Architectural Grid
    const gridCol = cssVar("--graph-grid", "rgba(255,255,255,0.04)");
    ctx.strokeStyle = gridCol;
    ctx.lineWidth = 1;
    const step = 32;
    ctx.beginPath();
    for (let x = step; x < w; x += step) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    for (let y = step; y < h; y += step) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();

    const arcBase = cssVar("--graph-arc", "rgba(195,205,222,0.24)");
    const arcActive = cssVar("--graph-arc-active", "#38BDF8");
    const amber = cssVar("--accent-amber", "#F0B44C");
    const emerald = cssVar("--status-emerald", "#34D399");
    const coral = cssVar("--status-coral", "#FB7185");
    const nodeFill = cssVar("--graph-node-fill", "#111621");
    const nodeStroke = cssVar("--graph-node-stroke", "rgba(255,255,255,0.22)");
    const inkPrimary = cssVar("--ink-primary", "#F2F5FA");
    const inkMuted = cssVar("--ink-muted", "#8E9BB2");

    if (graphState.layerMode === "peer-mesh") {
      const arcCtrlMap = new Map();
      for (const lnk of graphState.data.links) {
        const p1 = graphState.nodePositions.get(lnk.from);
        const p2 = graphState.nodePositions.get(lnk.to);
        if (!p1 || !p2) continue;
        const isHighlighted = lnk.from === graphState.selectedNodeId || lnk.to === graphState.selectedNodeId;
        const c1 = drawCurvedArc(ctx, p1, p2, 18, isHighlighted ? arcActive : arcBase, isHighlighted ? 1.65 : 1.1, null);
        const c2 = drawCurvedArc(ctx, p2, p1, 18, isHighlighted ? amber : arcBase, isHighlighted ? 1.35 : 0.95, [4, 4]);
        arcCtrlMap.set(lnk.from + "->" + lnk.to, { p1, p2, ctrl: c1 });
        arcCtrlMap.set(lnk.to + "->" + lnk.from, { p1: p2, p2: p1, ctrl: c2 });
      }

      // Draw directional message particles
      for (let i = graphState.particles.length - 1; i >= 0; i--) {
        const pt = graphState.particles[i];
        let route = arcCtrlMap.get(pt.from + "->" + pt.to);
        if (!route) {
          const pa = graphState.nodePositions.get(pt.from);
          const pb = graphState.nodePositions.get(pt.to);
          if (pa && pb) {
            route = { p1: pa, p2: pb, ctrl: { ctrlX: (pa.x + pb.x) * 0.5, ctrlY: (pa.y + pb.y) * 0.5 - 16 } };
          }
        }
        if (route) {
          const pos = pointOnQuadBezier(route.p1, route.ctrl, route.p2, pt.t);
          ctx.beginPath();
          ctx.fillStyle = pt.burst ? emerald : (pt.reverse ? amber : arcActive);
          ctx.arc(pos.x, pos.y, pt.burst ? 4.5 : 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
        if (!graphState.reducedMotion) {
          pt.t += pt.speed;
          if (pt.t >= 1) {
            if (pt.burst) graphState.particles.splice(i, 1);
            else pt.t = 0;
          }
        }
      }
    } else {
      // Graphify Provenance Layer (EXTRACTED / INFERRED / AMBIGUOUS)
      const visitedSet = new Set(graphState.traversalResult ? graphState.traversalResult.visited : []);
      for (const edge of graphState.data.graphifyEdges) {
        const p1 = graphState.nodePositions.get(edge.from);
        const p2 = graphState.nodePositions.get(edge.to);
        if (!p1 || !p2) continue;
        let col = emerald;
        let dash = null;
        if (edge.provenance === "INFERRED") { col = arcActive; dash = [6, 4]; }
        if (edge.provenance === "AMBIGUOUS") { col = coral; dash = [2, 4]; }
        const activeEdge = !visitedSet.size || (visitedSet.has(edge.from) && visitedSet.has(edge.to)) || edge.provenance === "AMBIGUOUS";
        ctx.globalAlpha = activeEdge ? 0.95 : 0.25;
        drawCurvedArc(ctx, p1, p2, 16, col, activeEdge ? 1.8 : 1.0, dash);
        ctx.globalAlpha = 1;
      }
    }

    // Draw Nodes
    for (const [id, info] of graphState.nodePositions.entries()) {
      const isSelected = id === graphState.selectedNodeId;
      const isHovered = id === graphState.hoveredNodeId;

      if (isSelected) {
        ctx.beginPath();
        ctx.arc(info.x, info.y, info.r + 6, 0, Math.PI * 2);
        ctx.strokeStyle = amber;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(info.x, info.y, info.r, 0, Math.PI * 2);
      ctx.fillStyle = nodeFill;
      ctx.fill();
      ctx.lineWidth = isSelected || isHovered ? 2 : 1.25;
      ctx.strokeStyle = isSelected ? amber : (isHovered ? arcActive : nodeStroke);
      ctx.stroke();

      // Short glyph inside circle
      ctx.fillStyle = isSelected ? amber : inkPrimary;
      ctx.font = "700 11px 'Cascadia Mono', Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const code = (info.node.label || id).slice(0, 3).toUpperCase();
      ctx.fillText(code, info.x, info.y);

      // Node Label Pill underneath
      ctx.font = "600 11.5px 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
      ctx.fillStyle = inkPrimary;
      ctx.fillText(info.node.label || id, info.x, info.y + info.r + 14);

      ctx.font = "10px 'Cascadia Mono', Consolas, monospace";
      ctx.fillStyle = inkMuted;
      const sub = info.node.role ? (info.node.role + " • e" + info.node.epoch) : (info.node.kind || "");
      ctx.fillText(sub, info.x, info.y + info.r + 27);
    }

    ctx.restore();
  }

  function startAnimationLoop() {
    if (graphState.animFrameId) cancelAnimationFrame(graphState.animFrameId);
    function tick() {
      const viewEl = document.getElementById("view-graph");
      if (viewEl && viewEl.classList.contains("is-active") && !document.hidden) {
        renderCanvasFrame();
      }
      if (!graphState.reducedMotion) {
        graphState.animFrameId = requestAnimationFrame(tick);
      }
    }
    renderCanvasFrame();
    if (!graphState.reducedMotion) {
      graphState.animFrameId = requestAnimationFrame(tick);
    }
  }

  function renderNodeStripAndInspector() {
    if (!graphState.data) return;
    const strip = document.getElementById("graphAccessibleNodeStrip");
    const inspector = document.getElementById("graphNodeInspector");
    const msgLog = document.getElementById("graphMessageLedger");

    const activeNodes = graphState.layerMode === "peer-mesh"
      ? graphState.data.nodes
      : graphState.data.graphifyNodes;

    if (strip) {
      strip.innerHTML = activeNodes.map((n) => (
        '<button type="button" class="btn ' + (n.id === graphState.selectedNodeId ? "btn-primary" : "btn-subtle") +
          '" style="min-height:28px;padding:0 9px;" data-select-node="' + escapeHtml(n.id) + '">' +
          escapeHtml(n.label) +
        "</button>"
      )).join("");
    }

    if (inspector) {
      const peerNode = graphState.data.nodes.find((n) => n.id === graphState.selectedNodeId);
      const gNode = graphState.data.graphifyNodes.find((n) => n.id === graphState.selectedNodeId);
      if (peerNode) {
        inspector.innerHTML =
          '<div class="row-between">' +
            '<strong>' + escapeHtml(peerNode.label) + '</strong>' +
            '<span class="badge badge-emerald">◆ ' + escapeHtml(peerNode.state) + "</span>" +
          "</div>" +
          '<div class="mono muted" style="font-size:11px;">Role: ' + escapeHtml(peerNode.role) +
            " • Epoch: " + escapeHtml(peerNode.epoch) +
            " • max_hops: " + escapeHtml(peerNode.maxHops) + "</div>" +
          '<div class="row-wrap" style="margin-top:4px;">' +
            '<span class="badge badge-cyan">Incoming O(1): ' + escapeHtml(peerNode.incomingCount) + "</span>" +
            '<span class="badge badge-amber">Outgoing O(1): ' + escapeHtml(peerNode.outgoingCount) + "</span>" +
            '<span class="badge">Cursor seq #' + escapeHtml(peerNode.lastSeq) + "</span>" +
          "</div>" +
          '<div style="margin-top:6px;">' +
            '<div class="section-eyebrow" style="margin-bottom:4px;">Disjoint Write-Isolation Scope</div>' +
            (peerNode.disjointPaths || []).map((p) => '<div class="mono" style="font-size:11px;color:var(--accent-amber);">• ' + escapeHtml(p) + "</div>").join("") +
          "</div>";
      } else if (gNode) {
        inspector.innerHTML =
          '<div class="row-between">' +
            '<strong>' + escapeHtml(gNode.label) + '</strong>' +
            '<span class="badge badge-cyan">' + escapeHtml(gNode.kind) + "</span>" +
          "</div>" +
          '<div class="mono secondary" style="font-size:11.5px;margin-top:4px;">Locator: ' + escapeHtml(gNode.path) + "</div>";
      }
    }

    if (msgLog) {
      const msgs = (graphState.data.messages || []).slice(-8).reverse();
      msgLog.innerHTML = msgs.map((m) => (
        '<div class="atelier-card" style="padding:8px 10px;">' +
          '<div class="row-between mono" style="font-size:11px;">' +
            '<span style="color:var(--accent-cyan);">#' + escapeHtml(m.seq) + " " + escapeHtml(m.from) + " ⇄ " + escapeHtml(m.to) + "</span>" +
            '<span class="muted">e' + escapeHtml(m.epoch) + " • " + escapeHtml(m.timestamp || "") + "</span>" +
          "</div>" +
          '<div style="font-size:12px;margin-top:3px;">' + escapeHtml(m.text) + "</div>" +
        "</div>"
      )).join("");
    }
  }

  function renderTraversalLedger() {
    const out = document.getElementById("graphTraversalOutput");
    if (!out || !graphState.traversalResult) return;
    const res = graphState.traversalResult;
    const edgesHtml = (res.edges || []).map((e) => {
      const cls = e.provenance === "EXTRACTED" ? "badge-extracted" : "badge-inferred";
      return (
        '<div class="row-between" style="padding:4px 0;border-bottom:1px solid var(--border-subtle);font-size:11.5px;">' +
          '<span class="mono">' + escapeHtml(e.from) + " → " + escapeHtml(e.to) + " (" + escapeHtml(e.relation) + ")</span>" +
          '<span class="badge ' + cls + '">' + escapeHtml(e.provenance) + "</span>" +
        "</div>"
      );
    }).join("");

    const ambigHtml = (res.quarantinedAmbiguous || []).map((q) => (
      '<div style="margin-top:6px;padding:6px 8px;border:1px solid var(--status-coral-border);background:var(--status-coral-tint);border-radius:3px;font-size:11px;">' +
        '<span class="badge badge-ambiguous">QUARANTINED AMBIGUOUS</span> ' +
        '<span class="mono">' + escapeHtml(q.from) + " ⇢ " + escapeHtml(q.to) + "</span> — " + escapeHtml(q.note || "") +
      "</div>"
    )).join("");

    out.innerHTML =
      '<div class="mono muted" style="font-size:11px;margin-bottom:4px;">Visited (' +
      (res.visited ? res.visited.length : 0) + "): " + escapeHtml((res.visited || []).join(", ")) + "</div>" +
      (edgesHtml || '<div class="muted" style="font-size:11.5px;">No active edges in selected direction.</div>') +
      ambigHtml;
  }

  async function runTraversal() {
    const entitySel = document.getElementById("graphTraverseEntity");
    const dirSel = document.getElementById("graphTraverseDirection");
    const depthSel = document.getElementById("graphTraverseDepth");
    const entity = entitySel ? entitySel.value : "omnia-studio";
    const dir = dirSel ? dirSel.value : "Both";
    const depth = depthSel ? Number(depthSel.value) : 3;

    graphState.traversalResult = await Studio.api.traverseGraph(entity, dir, depth);
    renderTraversalLedger();
    renderCanvasFrame();
  }

  async function init() {
    graphState.reducedMotion = Boolean(
      global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
    graphState.data = await Studio.api.getGraph();
    seedAmbientParticles();
    renderNodeStripAndInspector();
    await runTraversal();

    const canvas = document.getElementById("peerMeshCanvas");
    if (canvas) {
      canvas.addEventListener("mousemove", (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        let hit = null;
        for (const [id, info] of graphState.nodePositions.entries()) {
          if (Math.hypot(mx - info.x, my - info.y) <= info.r + 6) {
            hit = id;
            break;
          }
        }
        if (hit !== graphState.hoveredNodeId) {
          graphState.hoveredNodeId = hit;
          renderCanvasFrame();
        }
      });

      canvas.addEventListener("click", (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        for (const [id, info] of graphState.nodePositions.entries()) {
          if (Math.hypot(mx - info.x, my - info.y) <= info.r + 8) {
            graphState.selectedNodeId = id;
            renderNodeStripAndInspector();
            renderCanvasFrame();
            break;
          }
        }
      });
    }

    const strip = document.getElementById("graphAccessibleNodeStrip");
    if (strip) {
      strip.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-select-node]");
        if (!btn) return;
        graphState.selectedNodeId = btn.getAttribute("data-select-node");
        renderNodeStripAndInspector();
        renderCanvasFrame();
      });
    }

    document.querySelectorAll("[data-graph-layer]").forEach((btn) => {
      btn.addEventListener("click", () => {
        graphState.layerMode = btn.getAttribute("data-graph-layer") || "peer-mesh";
        document.querySelectorAll("[data-graph-layer]").forEach((b) => {
          b.setAttribute("aria-pressed", String(b === btn));
        });
        graphState.selectedNodeId = graphState.layerMode === "peer-mesh" ? "ui-atelier" : "omnia-studio";
        renderNodeStripAndInspector();
        renderCanvasFrame();
      });
    });

    const sendForm = document.getElementById("peerDispatchForm");
    if (sendForm) {
      sendForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fromEl = document.getElementById("peerSendFrom");
        const toEl = document.getElementById("peerSendTo");
        const txtEl = document.getElementById("peerSendText");
        const from = fromEl ? fromEl.value : "ui-atelier";
        const to = toEl ? toEl.value : "cpp-core";
        const text = txtEl && txtEl.value.trim() ? txtEl.value.trim() : "Duplex verification ping";

        const resp = await Studio.api.sendGraphMessage({
          from,
          to,
          text,
          broadcast: to === "@all"
        });
        if (resp && Array.isArray(resp.messages)) {
          graphState.data.messages = resp.messages;
        }
        graphState.layerMode = "peer-mesh";
        spawnPulseBurst(from, to);
        if (txtEl) txtEl.value = "";
        renderNodeStripAndInspector();
        renderCanvasFrame();
      });
    }

    const traverseBtn = document.getElementById("btnRunGraphifyTraverse");
    if (traverseBtn) traverseBtn.addEventListener("click", runTraversal);

    global.addEventListener("resize", () => renderCanvasFrame());
    startAnimationLoop();
  }

  Studio.peerGraph = {
    init,
    redraw: renderCanvasFrame,
    focusNode(nodeId) {
      if (!graphState.data) return;
      const inGraphify = graphState.data.graphifyNodes.some((n) => n.id === nodeId);
      graphState.layerMode = inGraphify ? "graphify" : "peer-mesh";
      graphState.selectedNodeId = nodeId;
      renderNodeStripAndInspector();
      renderCanvasFrame();
    },
    async broadcastPulse(messageText) {
      await Studio.api.sendGraphMessage({
        from: "coordinator",
        to: "@all",
        text: messageText || "Global duplex convergence check across all 6 peers.",
        broadcast: true
      });
      graphState.data = await Studio.api.getGraph();
      spawnPulseBurst("coordinator", "@all");
      renderNodeStripAndInspector();
      renderCanvasFrame();
    }
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
