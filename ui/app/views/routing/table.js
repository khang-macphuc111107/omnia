// Omnia Studio UI — Routing view: pure helpers for the provider table, scores and receipts.
// No DOM access; unit-tested in Node. Text is produced by the view through t(), these
// helpers only return keys, variants and numbers.

export const CIRCUITS = ['Closed', 'HalfOpen', 'Open'];

const CIRCUIT_VIEW = {
  Closed: { variant: 'ok', icon: 'check-circle', key: 'closed' },
  HalfOpen: { variant: 'warn', icon: 'alert', key: 'halfOpen' },
  Open: { variant: 'danger', icon: 'stop', key: 'open' }
};

/** Circuit state → status variant, icon and string key (unknown values stay visible as raw text). */
export function circuitView(circuit) {
  return CIRCUIT_VIEW[circuit] || { variant: '', icon: 'info', key: 'other' };
}

export function summarize(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  return {
    total: list.length,
    closed: list.filter((c) => c.circuit === 'Closed').length,
    halfOpen: list.filter((c) => c.circuit === 'HalfOpen').length,
    open: list.filter((c) => c.circuit === 'Open').length
  };
}

export const PRIVACY_KEYS = ['strict_local_zero_retention', 'enterprise_zdr', 'private_vpc', 'standard_cloud'];

/** Key suffix for routing.privacy.*, or null for a tier this UI does not know (shown raw). */
export function privacyKey(tier) {
  return PRIVACY_KEYS.includes(tier) ? tier : null;
}

/** Largest remainingTokens among candidates whose quota is Known; the meter scale. */
export function maxKnownRemaining(candidates) {
  let max = 0;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (c.quotaState === 'Known' && Number.isFinite(c.remainingTokens) && c.remainingTokens > max) max = c.remainingTokens;
  }
  return max;
}

export function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
}

/**
 * Quota presentation. kind: 'known' | 'stale' | 'unknown' | 'contradictory'.
 * - Known: meter filled to remaining / maxKnown (scaled to the largest Known remaining).
 * - Stale / Contradictory: the value, if any, is unverified and never drawn on the meter.
 * - Unknown (or any unrecognised state): never coerced to 0; no number at all.
 */
export function quotaView(candidate, maxKnown) {
  const remaining = Number.isFinite(candidate && candidate.remainingTokens) ? candidate.remainingTokens : null;
  const reserve = Number.isFinite(candidate && candidate.reserveTokens) ? candidate.reserveTokens : null;
  switch (candidate && candidate.quotaState) {
    case 'Known':
      return {
        kind: 'known',
        remaining,
        reserve,
        pct: remaining !== null && maxKnown > 0 ? clampPercent((remaining / maxKnown) * 100) : 0,
        max: maxKnown
      };
    case 'Stale':
      return { kind: 'stale', remaining, reserve, pct: 0, max: maxKnown };
    case 'Contradictory':
      return { kind: 'contradictory', remaining, reserve, pct: 0, max: maxKnown };
    default:
      return { kind: 'unknown', remaining: null, reserve, pct: 0, max: maxKnown };
  }
}

/** "sha256:8880f710b9569533" → "8880f710…9533"; long digests are shortened the same way. */
export function shortHash(hash, head = 8, tail = 4) {
  const body = String(hash ?? '').replace(/^sha256:/, '');
  if (!body) return '—';
  return body.length <= head + tail + 1 ? body : `${body.slice(0, head)}…${body.slice(-tail)}`;
}

/** Receipts newest first (decidedAt, then receipt id), as the server caps them at 10. */
export function sortReceipts(receipts) {
  return [...(Array.isArray(receipts) ? receipts : [])].sort(
    (a, b) => Number(b.decidedAt) - Number(a.decidedAt) || String(b.receiptId).localeCompare(String(a.receiptId))
  );
}

export const SCORE_KEYS = ['capability', 'privacy', 'quota', 'latency', 'reliability'];
const SCORE_FIELDS = {
  capability: 'capabilityScore',
  privacy: 'privacyScore',
  quota: 'quotaScore',
  latency: 'latencyScore',
  reliability: 'reliabilityScore'
};

/**
 * Score rows for the stackbars. The five component scores of an eligible candidate can add
 * up to more than 100 (totalScore itself is capped at 100 while totalScoreBps is not), so the
 * bar scale is max(100, largest component sum): every bar fits and bars stay comparable.
 * Rows: eligible first, then by totalScoreBps (desc), then id.
 */
export function normalizeScores(scores) {
  const list = (Array.isArray(scores) ? scores : []).map((score) => {
    const parts = SCORE_KEYS.map((key) => Math.max(0, Number(score[SCORE_FIELDS[key]]) || 0));
    return {
      candidateId: score.candidateId,
      eligible: Boolean(score.eligible),
      total: Number(score.totalScore) || 0,
      bps: Number(score.totalScoreBps) || 0,
      rawTotal: (Number(score.totalScoreBps) || 0) / 100,
      parts,
      sum: parts.reduce((a, b) => a + b, 0),
      preference: Number(score.preferenceScore) || 0,
      priority: Number(score.priorityScore) || 0,
      rejectedReason: score.rejectedReason || null
    };
  });
  const scale = Math.max(100, ...list.filter((row) => row.eligible).map((row) => row.sum));
  const rows = list.map((row) => ({
    ...row,
    segments: SCORE_KEYS.map((key, index) => ({ key, value: row.parts[index], pct: row.eligible ? clampPercent((row.parts[index] / scale) * 100) : 0 }))
  }));
  rows.sort(
    (a, b) =>
      Number(b.eligible) - Number(a.eligible) || b.bps - a.bps || String(a.candidateId).localeCompare(String(b.candidateId))
  );
  return { rows, scale };
}

export function findCandidate(candidates, id) {
  return (Array.isArray(candidates) ? candidates : []).find((c) => c.id === id) || null;
}

/** Sorted list of [flag, boolean] from capabilitiesFlags. */
export function flagList(flags) {
  return Object.entries(flags && typeof flags === 'object' ? flags : {})
    .map(([name, value]) => [name, Boolean(value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** rejectedReason may hold several reasons separated by commas. */
export function splitReasons(reason) {
  return String(reason ?? '')
    .split(/\s*,\s*/)
    .filter(Boolean);
}
