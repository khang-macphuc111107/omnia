// Omnia Studio UI — Agents view: pure helpers for the Graphify (code graph) tab.

import { fold } from '../../core/i18n.js';

export const MIN_DEPTH = 1;
export const MAX_DEPTH = 8;
export const DEFAULT_DEPTH = 3;
export const DIRECTIONS = ['Both', 'Forward', 'Reverse'];

export function normalizeDepth(value, fallback = DEFAULT_DEPTH) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, n));
}

export function normalizeDirection(value) {
  return DIRECTIONS.includes(value) ? value : 'Both';
}

function matches(node, needle) {
  if (!needle) return true;
  return fold(`${node.id} ${node.label || ''} ${node.kind || ''} ${node.path || ''} ${node.summary || ''}`).includes(needle);
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Entities grouped by kind (kinds A→Z, items by id), filtered accent-insensitively. */
export function groupEntities(nodes, query = '') {
  const needle = fold(query).trim();
  const groups = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!matches(node, needle)) continue;
    const kind = node.kind || '—';
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(node);
  }
  return Array.from(groups.entries())
    .sort((a, b) => byText(a[0], b[0]))
    .map(([kind, items]) => ({ kind, count: items.length, items: items.sort((a, b) => byText(a.id, b.id)) }));
}

/** Root used before the user picks one: the entity with the most edges, ties by id. */
export function defaultRoot(nodes, edges) {
  const degree = new Map();
  for (const edge of Array.isArray(edges) ? edges : []) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }
  let best = '';
  let bestDegree = -1;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const d = degree.get(node.id) || 0;
    if (d > bestDegree || (d === bestDegree && node.id < best)) {
      best = node.id;
      bestDegree = d;
    }
  }
  return best;
}

/** Normalised traverse response (the server returns empty arrays for unknown entities). */
export function readTraverse(result) {
  const edges = Array.isArray(result && result.edges) ? result.edges : [];
  const visitedIds = Array.isArray(result && result.visited) ? result.visited : [];
  const entities = Array.isArray(result && result.visitedEntities) ? result.visitedEntities : visitedIds.map((id) => ({ id }));
  const quarantined = Array.isArray(result && result.quarantinedAmbiguous) ? result.quarantinedAmbiguous : [];
  return {
    edges,
    entities,
    quarantined,
    entityCount: entities.length,
    edgeCount: edges.length,
    empty: entities.length === 0 && edges.length === 0
  };
}

/** confidenceBps (0–10000) → 0–100, or null when absent. */
export function confidencePercent(bps) {
  if (bps === null || bps === undefined || bps === '') return null;
  const n = Number(bps);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n / 100)) : null;
}
