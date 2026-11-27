// Omnia Studio UI — local chat storage (schema shared with Settings → Local data).
//
//   localStorage key  omnia.ui.chat.<sessionId>
//   value             { v: 1, messages: [{ id, role:'user', markdown, attachments:[…], createdAt, route }],
//                       draft: { text, rev, attachments:[{ id, name, size, mime, sha256, placement }] } }
//   route             { state:'pending'|'routed'|'fenced'|'error', selectedCandidateId, receipt, status,
//                       errorCode, policy }
// Only the newest 200 messages are kept. The pure helpers below never touch storage.

import { storage } from '../../core/store.js';
import { hasLatex } from '../../lib/markdown.js';

export const KEY_PREFIX = 'omnia.ui.chat.';
export const SCHEMA_VERSION = 1;
export const MAX_MESSAGES = 200;
export const ROUTE_STATES = ['pending', 'routed', 'fenced', 'error'];
export const PLACEMENTS = ['inline', 'tray', 'both'];

export const chatKey = (sessionId) => `${KEY_PREFIX}${sessionId}`;

export function emptyChat() {
  return { v: SCHEMA_VERSION, messages: [], draft: { text: '', rev: 0, attachments: [] } };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value : '');
const count = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);

export function sanitizeAttachment(value) {
  if (!isObject(value) || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  return {
    id: value.sha256.slice(0, 8),
    name: text(value.name) || 'file',
    size: count(value.size),
    mime: text(value.mime) || 'application/octet-stream',
    sha256: value.sha256,
    placement: PLACEMENTS.includes(value.placement) ? value.placement : 'tray'
  };
}

function sanitizeAttachments(list) {
  return (Array.isArray(list) ? list : []).map(sanitizeAttachment).filter(Boolean);
}

export function sanitizeRoute(value) {
  const route = isObject(value) ? value : {};
  return {
    state: ROUTE_STATES.includes(route.state) ? route.state : 'error',
    selectedCandidateId: typeof route.selectedCandidateId === 'string' ? route.selectedCandidateId : null,
    receipt: isObject(route.receipt) ? route.receipt : null,
    status: text(route.status),
    errorCode: text(route.errorCode),
    policy: isObject(route.policy) ? route.policy : null
  };
}

export function sanitizeMessage(value) {
  if (!isObject(value) || typeof value.id !== 'string' || !/^[\w.-]{1,64}$/.test(value.id)) return null;
  return {
    id: value.id,
    role: 'user',
    markdown: text(value.markdown),
    attachments: sanitizeAttachments(value.attachments),
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    route: sanitizeRoute(value.route)
  };
}

export function trimMessages(messages) {
  return messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages;
}

/**
 * Normalises whatever is in storage. `inflight(messageId)` tells whether a route request for the
 * message is still running in this page; any other 'pending' route was interrupted by a reload.
 */
export function sanitizeChat(value, inflight = () => false) {
  if (!isObject(value)) return emptyChat();
  const messages = trimMessages((Array.isArray(value.messages) ? value.messages : []).map(sanitizeMessage).filter(Boolean)).map((message) =>
    message.route.state === 'pending' && !inflight(message.id)
      ? { ...message, route: { ...message.route, state: 'error', errorCode: 'interrupted' } }
      : message
  );
  const draft = isObject(value.draft) ? value.draft : {};
  return {
    v: SCHEMA_VERSION,
    messages,
    draft: { text: text(draft.text), rev: count(draft.rev), attachments: sanitizeAttachments(draft.attachments) }
  };
}

export function loadChat(sessionId, inflight) {
  return sanitizeChat(storage.get(chatKey(sessionId), null), inflight);
}

/** Returns true when the data was stored. */
export function saveChat(sessionId, chat) {
  const data = { v: SCHEMA_VERSION, messages: trimMessages(chat.messages), draft: chat.draft };
  return storage.set(chatKey(sessionId), data);
}

// ---------------------------------------------------------------------------
// Messages and routing policy
// ---------------------------------------------------------------------------

export function newMessageId() {
  const random =
    typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `m-${Date.now().toString(36)}-${random}`;
}

/** estimatedTokens = max(512, ceil(chars / 3) + 1024), shown to the user as an estimate. */
export function estimateTokens(chars) {
  return Math.max(512, Math.ceil(Number(chars) / 3) + 1024);
}

/** The router policy for a message: math_derivation when the text has LaTeX, else code_generation. */
export function buildPolicy(markdown) {
  const source = String(markdown ?? '');
  return {
    taskClass: hasLatex(source) ? 'math_derivation' : 'code_generation',
    estimatedTokens: estimateTokens(source.length),
    privacyTier: 'enterprise_zdr',
    requireStreaming: true
  };
}

// A retry of this message must replay the server receipt, even after a page reload.
export function messagePolicy(sessionId, messageId, markdown) {
  return { ...buildPolicy(markdown), idempotencyKey: `chat:${sessionId}:${messageId}` };
}

export function pendingRoute(policy) {
  return { state: 'pending', selectedCandidateId: null, receipt: null, status: '', errorCode: '', policy };
}

/** decide() answers HTTP 200 with ok:false or allowed:false when every route is fenced. */
export function routeFromResponse(payload, policy) {
  const selected = payload && typeof payload.selectedCandidateId === 'string' ? payload.selectedCandidateId : null;
  const routed = Boolean(payload && payload.ok !== false && payload.allowed !== false && selected);
  return {
    state: routed ? 'routed' : 'fenced',
    selectedCandidateId: selected,
    receipt: payload && isObject(payload.receipt) ? payload.receipt : null,
    status: payload && typeof payload.status === 'string' ? payload.status : '',
    errorCode: '',
    policy
  };
}

export function routeFromError(error, policy) {
  return {
    state: 'error',
    selectedCandidateId: null,
    receipt: null,
    status: '',
    errorCode: (error && typeof error.code === 'string' && error.code) || 'unknown',
    policy
  };
}

/** The message whose receipt the inspector shows: the focused one, else the newest with a receipt. */
export function receiptMessage(messages, focusId = null) {
  if (focusId) {
    const focused = messages.find((message) => message.id === focusId);
    if (focused) return focused;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].route && (messages[i].route.receipt || messages[i].route.state !== 'pending')) return messages[i];
  }
  return null;
}

/** Candidate score entry for the selected route (or null). */
export function selectedScore(route) {
  const scores = route && route.receipt && Array.isArray(route.receipt.scores) ? route.receipt.scores : [];
  const id = route.selectedCandidateId || (route.receipt && route.receipt.selectedRoute) || null;
  return id ? scores.find((entry) => entry.candidateId === id) || null : null;
}

export function rejectedScores(route) {
  const scores = route && route.receipt && Array.isArray(route.receipt.scores) ? route.receipt.scores : [];
  return scores.filter((entry) => entry && entry.eligible === false);
}

/** Component widths (percent of their sum) for the stackbar. */
export function scoreShares(score) {
  const parts = [score.capabilityScore, score.privacyScore, score.quotaScore, score.latencyScore, score.reliabilityScore].map(count);
  const sum = parts.reduce((total, part) => total + part, 0);
  return { parts, shares: parts.map((part) => (sum > 0 ? (part / sum) * 100 : 0)) };
}
