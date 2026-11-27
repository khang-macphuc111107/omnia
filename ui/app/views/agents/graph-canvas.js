// Omnia Studio UI — Agents view: the peer-mesh canvas controller.
//
// Draws on demand only: data, selection, hover, resize and theme changes each schedule
// ONE animation frame. The single exception is the message pulse (<= 600 ms), which runs
// a short frame chain and then stops. There is never an idle loop.

import { prefersReducedMotion } from '../../core/dom.js';
import {
  layoutMesh,
  hitTest,
  edgeEndpoints,
  arrowHead,
  lerpPoint,
  easeOutCubic,
  isIncident,
  nodeCode
} from './mesh.js';

export const PULSE_MS = 600;

function readColors(element) {
  const style = getComputedStyle(element);
  const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    line2: read('--line-2', '#2a2d34'),
    line3: read('--line-3', '#3b3f48'),
    bg: read('--bg', '#0e0f11'),
    surface: read('--surface-2', '#17191e'),
    surface4: read('--surface-4', '#2a2d34'),
    text1: read('--text-1', '#f2f3f5'),
    text2: read('--text-2', '#b7bac2'),
    text3: read('--text-3', '#8a8e98'),
    accent: read('--accent', '#f2a93b'),
    accentSoft: read('--accent-soft', 'rgba(242,169,59,0.13)'),
    glow: read('--accent-glow', ''),
    ok: read('--ok', '#3fcf8e'),
    fontUi: read('--font-ui', 'system-ui, sans-serif'),
    fontMono: read('--font-mono', 'ui-monospace, monospace')
  };
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text.length;
  while (cut > 1 && ctx.measureText(`${text.slice(0, cut)}…`).width > maxWidth) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

/**
 * @param {HTMLCanvasElement} canvas  child of the stage element (the stage sets the size)
 * @param {{ onSelect?: (id: string) => void }} handlers
 */
export function createMeshCanvas(canvas, { onSelect } = {}) {
  const ctx = canvas.getContext('2d');
  const stage = canvas.parentElement || canvas;
  let model = { nodes: [], links: [], selectedId: null };
  let layout = new Map();
  let hoverId = null;
  let size = { width: 0, height: 0, dpr: 1 };
  let frame = 0;
  let pulse = null; // { start, edges }
  let destroyed = false;

  const observer = new ResizeObserver(() => {
    measure();
    requestDraw();
  });
  observer.observe(stage);

  const themeObserver = new MutationObserver(() => requestDraw());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function measure() {
    const rect = stage.getBoundingClientRect();
    const width = Math.max(0, Math.floor(rect.width));
    const height = Math.max(0, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    if (width === size.width && height === size.height && dpr === size.dpr) return;
    size = { width, height, dpr };
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    layout = layoutMesh(model.nodes, width, height);
  }

  function requestDraw() {
    if (frame || destroyed) return;
    frame = requestAnimationFrame((now) => {
      frame = 0;
      draw(now);
    });
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onPointerMove(event) {
    const { x, y } = pointerPosition(event);
    const hit = hitTest(layout, x, y);
    if (hit === hoverId) return;
    hoverId = hit;
    canvas.classList.toggle('is-hover', Boolean(hit));
    requestDraw();
  }

  function onPointerLeave() {
    if (hoverId === null) return;
    hoverId = null;
    canvas.classList.remove('is-hover');
    requestDraw();
  }

  function onClick(event) {
    const { x, y } = pointerPosition(event);
    const hit = hitTest(layout, x, y);
    if (hit && onSelect) onSelect(hit);
  }

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('click', onClick);

  function drawGrid(colors) {
    ctx.fillStyle = colors.line2;
    for (let x = 12; x < size.width; x += 24) {
      for (let y = 12; y < size.height; y += 24) ctx.fillRect(x, y, 1.5, 1.5);
    }
  }

  function drawLink(link, colors, hot) {
    const a = layout.get(link.from);
    const b = layout.get(link.to);
    if (!a || !b) return;
    const seg = edgeEndpoints(a, b);
    if (seg.length === 0) return;
    ctx.strokeStyle = hot ? colors.accent : colors.line3;
    ctx.lineWidth = hot ? 1.8 : 1.2;
    ctx.beginPath();
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
    ctx.stroke();
    if (link.mode === 'Directed') {
      const [tip, left, right] = arrowHead(seg.x2, seg.y2, seg.angle);
      ctx.fillStyle = hot ? colors.accent : colors.text3;
      ctx.beginPath();
      ctx.moveTo(tip[0], tip[1]);
      ctx.lineTo(left[0], left[1]);
      ctx.lineTo(right[0], right[1]);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawNode(node, colors) {
    const point = layout.get(node.id);
    if (!point) return;
    const selected = node.id === model.selectedId;
    const hover = node.id === hoverId;
    const active = node.state === 'ACTIVE';
    if (selected) {
      ctx.fillStyle = colors.accentSoft;
      ctx.beginPath();
      ctx.arc(point.x, point.y, point.r + 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = colors.surface;
    ctx.strokeStyle = selected ? colors.accent : hover ? colors.text2 : colors.line3;
    ctx.lineWidth = selected ? 2 : 1.5;
    ctx.setLineDash(active ? [] : [4, 3]);
    ctx.beginPath();
    ctx.arc(point.x, point.y, point.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = active ? colors.text1 : colors.text3;
    ctx.font = `600 12px ${colors.fontMono}`;
    ctx.fillText(nodeCode(node), point.x, point.y + 0.5);

    // Labels sit on a plate in the canvas colour so edges never run through the text.
    ctx.textBaseline = 'alphabetic';
    ctx.font = `600 12px ${colors.fontUi}`;
    const label = fitText(ctx, node.label || node.id, 132);
    const labelWidth = ctx.measureText(label).width;
    ctx.font = `400 12px ${colors.fontUi}`;
    const role = fitText(ctx, node.role || '', 132);
    const roleWidth = role ? ctx.measureText(role).width : 0;
    const plateWidth = Math.max(labelWidth, roleWidth) + 10;
    ctx.fillStyle = colors.bg;
    ctx.fillRect(point.x - plateWidth / 2, point.y + point.r + 4, plateWidth, role ? 31 : 17);

    ctx.font = `600 12px ${colors.fontUi}`;
    ctx.fillStyle = colors.text1;
    ctx.fillText(label, point.x, point.y + point.r + 16);
    if (role) {
      ctx.font = `400 12px ${colors.fontUi}`;
      ctx.fillStyle = colors.text3;
      ctx.fillText(role, point.x, point.y + point.r + 30);
    }
  }

  function drawPulse(now, colors) {
    if (!pulse) return false;
    const progress = (now - pulse.start) / PULSE_MS;
    if (progress >= 1) {
      pulse = null;
      return false;
    }
    const eased = easeOutCubic(progress);
    for (const edge of pulse.edges) {
      const a = layout.get(edge.from);
      const b = layout.get(edge.to);
      if (!a || !b) continue;
      const p = lerpPoint(a, b, eased);
      ctx.fillStyle = colors.glow || colors.accentSoft;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = colors.accent;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    return true;
  }

  function draw(now) {
    if (destroyed || !ctx) return;
    measure();
    if (size.width === 0 || size.height === 0) return;
    const colors = readColors(canvas);
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    drawGrid(colors);
    const sel = model.selectedId;
    for (const link of model.links) if (!isIncident(link, sel)) drawLink(link, colors, false);
    for (const link of model.links) if (isIncident(link, sel)) drawLink(link, colors, true);
    for (const node of model.nodes) drawNode(node, colors);
    if (drawPulse(now, colors)) requestDraw();
  }

  return {
    setModel(next) {
      model = {
        nodes: Array.isArray(next.nodes) ? next.nodes : [],
        links: Array.isArray(next.links) ? next.links : [],
        selectedId: next.selectedId ?? null
      };
      layout = layoutMesh(model.nodes, size.width, size.height);
      if (hoverId && !layout.has(hoverId)) hoverId = null;
      requestDraw();
    },

    /** One pulse along each edge ({ from, to }); skipped under reduced motion. */
    pulse(edges) {
      if (!edges || edges.length === 0 || prefersReducedMotion()) return;
      pulse = { start: performance.now(), edges };
      requestDraw();
    },

    setLabel(text) {
      if (canvas.getAttribute('aria-label') !== text) canvas.setAttribute('aria-label', text);
    },

    destroy() {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pulse = null;
      observer.disconnect();
      themeObserver.disconnect();
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('click', onClick);
    }
  };
}
