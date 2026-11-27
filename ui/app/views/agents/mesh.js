// Omnia Studio UI — Agents view: pure helpers for the peer mesh (layout, hit-testing,
// geometry, status mapping). No DOM access, so everything here is unit-tested in Node.

export const MAX_LOG = 50;
export const NODE_RADIUS = 22;

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function sortNodes(nodes) {
  return [...(Array.isArray(nodes) ? nodes : [])].sort(byId);
}

/**
 * Deterministic layout: the coordinator-role node (first by id) sits in the centre,
 * every other node is placed on an ellipse ordered by id, starting at 12 o'clock and
 * going clockwise. Returns Map<id, { id, x, y, r }>.
 */
export function layoutMesh(nodes, width, height, { radius = NODE_RADIUS, padX = 76, padY = 52 } = {}) {
  const layout = new Map();
  const sorted = sortNodes(nodes);
  if (sorted.length === 0 || !(width > 0) || !(height > 0)) return layout;
  const cx = width / 2;
  const cy = height / 2;
  const hub = sorted.find((node) => node.role === 'coordinator') || null;
  const ring = sorted.filter((node) => node !== hub);
  const rx = Math.max(0, width / 2 - padX);
  const ry = Math.max(0, height / 2 - padY);
  if (hub) layout.set(hub.id, { id: hub.id, x: cx, y: cy, r: radius });
  if (!hub && ring.length === 1) {
    layout.set(ring[0].id, { id: ring[0].id, x: cx, y: cy, r: radius });
    return layout;
  }
  ring.forEach((node, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / ring.length;
    layout.set(node.id, { id: node.id, x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry, r: radius });
  });
  return layout;
}

/** Nearest node whose disc (plus slop) contains the point, else null. */
export function hitTest(layout, x, y, slop = 6) {
  let best = null;
  let bestDistance = Infinity;
  for (const point of layout.values()) {
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance <= point.r + slop && distance < bestDistance) {
      best = point.id;
      bestDistance = distance;
    }
  }
  return best;
}

/** Segment between two discs, trimmed to their borders (so arrowheads touch the ring). */
export function edgeEndpoints(a, b, gap = 2) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, angle: 0, length: 0 };
  const ux = dx / length;
  const uy = dy / length;
  return {
    x1: a.x + ux * (a.r + gap),
    y1: a.y + uy * (a.r + gap),
    x2: b.x - ux * (b.r + gap),
    y2: b.y - uy * (b.r + gap),
    angle: Math.atan2(dy, dx),
    length
  };
}

/** Three points of an arrowhead whose tip is at (x, y) and points along `angle`. */
export function arrowHead(x, y, angle, size = 9, spread = Math.PI / 7) {
  return [
    [x, y],
    [x - Math.cos(angle - spread) * size, y - Math.sin(angle - spread) * size],
    [x - Math.cos(angle + spread) * size, y - Math.sin(angle + spread) * size]
  ];
}

export function lerpPoint(a, b, t) {
  const k = Math.min(1, Math.max(0, t));
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

export function easeOutCubic(t) {
  const k = Math.min(1, Math.max(0, t));
  return 1 - (1 - k) ** 3;
}

export function isIncident(link, nodeId) {
  return Boolean(link) && (link.from === nodeId || link.to === nodeId);
}

/** "UI Atelier" → "UA"; "Coordinator" → "COO"; "Rust Core" → "RC". */
export function nodeCode(node) {
  const source = String((node && (node.label || node.id)) || '?');
  const words = source.split(/[^A-Za-z0-9À-ỹ]+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 3).map((word) => word[0]).join('').toUpperCase();
  return (words[0] || '?').slice(0, 3).toUpperCase();
}

/** The node shown when nothing (or something that vanished) is selected. */
export function effectiveSelection(nodes, selectedId) {
  const list = sortNodes(nodes);
  if (list.length === 0) return null;
  return list.find((node) => node.id === selectedId) || list.find((node) => node.role === 'coordinator') || list[0];
}

export function maxSeq(messages) {
  let max = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (Number(message.seq) > max) max = Number(message.seq);
  }
  return max;
}

export function recipientsOf(message) {
  if (!message) return [];
  if (Array.isArray(message.recipients) && message.recipients.length > 0) return message.recipients.map(String);
  return message.to ? [String(message.to)] : [];
}

/** Label for the "from → to" part of a log row. */
export function describeRoute(message) {
  const recipients = recipientsOf(message);
  if (recipients.length > 1) return recipients.join(', ');
  return recipients[0] || String((message && message.to) || '');
}

export function pulseEdges(message) {
  if (!message) return [];
  return recipientsOf(message)
    .filter((to) => to !== message.from)
    .map((to) => ({ from: message.from, to }));
}

/**
 * Compare the previous highest seq with a fresh message list. Returns the pulse for the
 * newest message, or null when nothing is new (or this is the first load: prevSeq === null).
 */
export function nextPulse(prevSeq, messages) {
  if (prevSeq === null || prevSeq === undefined) return null;
  const fresh = (Array.isArray(messages) ? messages : []).filter((message) => Number(message.seq) > prevSeq);
  if (fresh.length === 0) return null;
  const latest = fresh.reduce((best, message) => (Number(message.seq) > Number(best.seq) ? message : best));
  return { seq: Number(latest.seq), edges: pulseEdges(latest) };
}

/** Newest first, capped. */
export function logMessages(messages, limit = MAX_LOG) {
  return [...(Array.isArray(messages) ? messages : [])].sort((a, b) => Number(b.seq) - Number(a.seq)).slice(0, limit);
}

/** Provenance → status variant + icon (always shown with its text). */
export function provenanceView(provenance) {
  switch (String(provenance || '').toUpperCase()) {
    case 'EXTRACTED':
      return { variant: 'ok', icon: 'check-circle', label: 'EXTRACTED' };
    case 'INFERRED':
      return { variant: 'info', icon: 'info', label: 'INFERRED' };
    case 'AMBIGUOUS':
      return { variant: 'warn', icon: 'alert', label: 'AMBIGUOUS' };
    default:
      return { variant: '', icon: 'info', label: String(provenance || '?') };
  }
}

export function stateView(state) {
  return String(state || '').toUpperCase() === 'ACTIVE'
    ? { variant: 'ok', icon: 'check-circle', label: 'ACTIVE' }
    : { variant: 'warn', icon: 'clock', label: String(state || 'INACTIVE') };
}

export function countLinks(links) {
  let duplex = 0;
  let directed = 0;
  for (const link of Array.isArray(links) ? links : []) {
    if (link.mode === 'Directed') directed += 1;
    else duplex += 1;
  }
  return { duplex, directed };
}

export function meshEpoch(nodes) {
  let epoch = null;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (typeof node.epoch === 'number' && (epoch === null || node.epoch > epoch)) epoch = node.epoch;
  }
  return epoch;
}

/** Default sender/recipient pair for the send form, given the nodes and the selection. */
export function defaultPair(nodes, selectedId, current = {}) {
  const ids = sortNodes(nodes).map((node) => node.id);
  const from = ids.includes(current.from) ? current.from : ids.includes(selectedId) ? selectedId : ids[0] || '';
  const to = current.to === '@all' || ids.includes(current.to) ? current.to : ids.find((id) => id !== from) || ids[0] || '';
  return { from, to };
}

/** Defensive normalisation of the GET /api/graph payload. */
export function normalizeGraph(data) {
  const list = (value) => (Array.isArray(value) ? value : []);
  const source = data && typeof data === 'object' ? data : {};
  return {
    nodes: sortNodes(list(source.nodes)),
    links: list(source.links),
    messages: list(source.messages),
    graphifyNodes: list(source.graphifyNodes),
    graphifyEdges: list(source.graphifyEdges)
  };
}
