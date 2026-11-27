// Knowledge view — pure helpers (no DOM). Unit-tested in ui/tests/knowledge.test.js.

import { fold } from '../../core/i18n.js';
import { validateMemoryNamespace, validateMemoryKey } from '../../api.js';

export const TABS = ['memory', 'skills', 'rag'];
export const DEFAULT_TAB = 'memory';

/** First route param → tab id, or null when it is not a known tab. */
export function tabFromRoute(route) {
  const first = route && Array.isArray(route.params) ? route.params[0] : '';
  return TABS.includes(first) ? first : null;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function compareSegments(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Flat, depth-first list of namespace nodes with the number of entries stored at or
 * below each node: [{ path, name, depth, count }]. Parents always precede children.
 */
export function buildNamespaceTree(entries) {
  const counts = new Map();
  for (const entry of entries || []) {
    const segments = String(entry.namespace || '').split('/').filter(Boolean);
    for (let i = 1; i <= segments.length; i += 1) {
      const path = segments.slice(0, i).join('/');
      counts.set(path, (counts.get(path) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([path, count]) => {
      const segments = path.split('/');
      return { path, name: segments[segments.length - 1], depth: segments.length - 1, count, segments };
    })
    .sort((a, b) => compareSegments(a.segments, b.segments))
    .map(({ segments, ...node }) => node);
}

export function inNamespace(entry, path) {
  if (!path) return true;
  const ns = String(entry.namespace || '');
  return ns === path || ns.startsWith(`${path}/`);
}

/** Namespace + accent-insensitive text filter (every word must match id, content or tier). Newest first. */
export function filterEntries(entries, { namespace = '', text = '' } = {}) {
  const words = fold(text).split(/\s+/).filter(Boolean);
  return (entries || [])
    .filter((entry) => {
      if (!inNamespace(entry, namespace)) return false;
      if (words.length === 0) return true;
      const haystack = fold(`${entry.id} ${entry.content} ${entry.tier}`);
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.id).localeCompare(String(b.id)));
}

/** "3f9a07c2…c21d" */
export function shortSha(sha) {
  const value = String(sha || '');
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

const TIERS = {
  Durable: { variant: 'info', icon: 'database', labelKey: 'knowledge.tierDurable' },
  Working: { variant: 'warn', icon: 'clock', labelKey: 'knowledge.tierWorking' }
};

export function tierMeta(tier) {
  return TIERS[tier] || TIERS.Durable;
}

const NON_ASCII = /[^\x00-\x7f]/;

/**
 * Refines the platform validators into a user-facing issue code, or null when valid.
 * Codes: empty | too_long | too_deep | dot_dot | diacritics | bad_slash | key_slash | segment_long | bad_chars
 */
export function memoryFieldIssue(field, value) {
  const text = String(value ?? '');
  const code = field === 'key' ? validateMemoryKey(text) : validateMemoryNamespace(text);
  if (!code) return null;
  if (code !== 'bad_chars') return code;
  if (NON_ASCII.test(text)) return 'diacritics';
  if (field === 'key') {
    if (text.includes('/')) return 'key_slash';
  } else if (text.startsWith('/') || text.endsWith('/') || text.includes('//')) {
    return 'bad_slash';
  }
  if (text.split('/').some((segment) => segment.length > 64)) return 'segment_long';
  return 'bad_chars';
}

export function validateMemoryForm({ namespace, key }) {
  const ns = memoryFieldIssue('namespace', namespace);
  const k = memoryFieldIssue('key', key);
  return { namespace: ns, key: k, valid: !ns && !k };
}

/** Lists the offending non-ASCII characters (unique, in order) for the diacritics message. */
export function offendingChars(value, limit = 6) {
  const seen = [];
  for (const ch of String(value ?? '')) {
    if (NON_ASCII.test(ch) && !seen.includes(ch)) seen.push(ch);
    if (seen.length >= limit) break;
  }
  return seen.join(' ');
}

/** Server erasure receipts + receipts created in this UI session, de-duplicated, newest first. */
export function mergeReceipts(server, local) {
  const byId = new Map();
  for (const receipt of [...(local || []), ...(server || [])]) {
    if (receipt && receipt.receiptId && !byId.has(receipt.receiptId)) byId.set(receipt.receiptId, receipt);
  }
  return Array.from(byId.values()).sort((a, b) => (b.erasedAt || 0) - (a.erasedAt || 0));
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** Quick searches: label shown to the user, query actually sent to the server. */
export const SKILL_QUICK = [
  { id: 'cpp', labelKey: 'knowledge.quickCpp', query: 'cpp' },
  { id: 'graph', labelKey: 'knowledge.quickGraph', query: 'graph' },
  { id: 'steer', labelKey: 'knowledge.quickSteer', query: 'steer' },
  { id: 'clean', labelKey: 'knowledge.quickClean', query: 'clean' },
  { id: 'vi', labelKey: 'knowledge.quickVi', query: 'vietnamese' }
];

export function normalizeQuery(q) {
  return String(q ?? '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// RAG
// ---------------------------------------------------------------------------

export const RAG_SAMPLES = [
  { id: 'vi-uia', labelKey: 'knowledge.sampleUia', query: 'Tại sao cửa sổ modal #32770 cần WH_CBT hook để UIA InvokePattern chạy nền ổn định?' },
  { id: 'en-wal', labelKey: 'knowledge.sampleWal', query: 'How does the SQLite WAL session lease keep two processes from writing the same session?' },
  { id: 'vi-sha', labelKey: 'knowledge.sampleSha', query: 'Khử trùng lặp tệp đính kèm bằng SHA-256 hoạt động thế nào trong composer?' }
];

export function uncertaintyPercent(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(1, Math.max(0, n)) * 100);
}

export function provenanceVariant(provenance) {
  switch (String(provenance || '').toUpperCase()) {
    case 'EXTRACTED':
      return 'ok';
    case 'INFERRED':
      return 'info';
    case 'AMBIGUOUS':
      return 'warn';
    default:
      return '';
  }
}

export function languageLabelKey(language) {
  return ['vi', 'en', 'bilingual'].includes(language) ? `knowledge.lang.${language}` : 'knowledge.lang.unknown';
}

/** "specification_contract" → "specification contract" (fallback when no translation exists). */
export function humanizeCode(code) {
  return String(code ?? '').replace(/[_-]+/g, ' ').trim();
}
