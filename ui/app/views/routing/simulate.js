// Omnia Studio UI — Routing view: pure helpers for the simulation panel (policy, results).

import { TASK_CLASSES, PRIVACY_TIERS } from '../../api.js';

export const POLICY_KEY = 'omnia.ui.routing.policy';
export const MIN_TOKENS = 64;
export const MAX_TOKENS = 120000;
export const RANGE_STEP = 64;

export const DEFAULT_POLICY = Object.freeze({
  taskClass: 'code_generation',
  estimatedTokens: 8192,
  privacyTier: 'enterprise_zdr',
  requireStreaming: true
});

export function clampTokens(value, fallback = DEFAULT_POLICY.estimatedTokens) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_TOKENS, Math.max(MIN_TOKENS, n));
}

/** Validate a stored/edited policy; anything unknown falls back to the default. */
export function sanitizePolicy(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    taskClass: TASK_CLASSES.includes(source.taskClass) ? source.taskClass : DEFAULT_POLICY.taskClass,
    estimatedTokens: clampTokens(source.estimatedTokens),
    privacyTier: PRIVACY_TIERS.includes(source.privacyTier) ? source.privacyTier : DEFAULT_POLICY.privacyTier,
    requireStreaming: typeof source.requireStreaming === 'boolean' ? source.requireStreaming : DEFAULT_POLICY.requireStreaming
  };
}

/** Request body for POST /api/router/decide. `extra` carries simulation or circuit actions. */
export function decideBody(policy, extra = {}) {
  const clean = sanitizePolicy(policy);
  const body = { ...clean };
  if (extra.tripCandidate) body.tripCandidate = String(extra.tripCandidate);
  if (extra.resetCandidate) body.resetCandidate = String(extra.resetCandidate);
  if (extra.simulate === true) body.simulate = true;
  return body;
}

/** Status of a decision response → chip variant/icon/key. */
export function decisionView(decision) {
  const status = String((decision && decision.status) || '');
  if (
    (status === 'ROUTED' || status === 'ROUTED_DETERMINISTIC' || status === 'SIMULATED_DETERMINISTIC') &&
    decision.ok !== false &&
    decision.allowed !== false
  ) {
    return { variant: 'ok', icon: 'check-circle', label: status };
  }
  if (status.startsWith('FENCED') || (decision && decision.allowed === false)) {
    return { variant: 'danger', icon: 'stop', label: status || 'FENCED' };
  }
  return { variant: 'warn', icon: 'alert', label: status || '—' };
}

/** Receipt as key/value rows; null stays null so the view can print "—" instead of a fake 0. */
export function receiptRows(receipt) {
  const r = receipt && typeof receipt === 'object' ? receipt : {};
  return [
    { key: 'receiptId', value: r.receiptId ?? null, mono: true },
    { key: 'sequenceId', value: r.sequenceId ?? null, mono: true, number: true },
    { key: 'reservationId', value: r.reservationId ?? null, mono: true },
    { key: 'policyClass', value: r.policyClass ?? null, mono: true },
    { key: 'policyHash', value: r.policyHash ?? null, mono: true, copy: true },
    { key: 'reservedTokens', value: r.reservedTokens ?? null, number: true },
    { key: 'promptRedacted', value: typeof r.promptRedacted === 'boolean' ? r.promptRedacted : null, bool: true },
    { key: 'secretsExposed', value: r.secretsExposed ?? null, number: true },
    { key: 'estimatedCostMicrounits', value: r.estimatedCostMicrounits ?? null, number: true },
    { key: 'schemaVersion', value: r.schemaVersion ?? null, mono: true },
    { key: 'redactionPolicy', value: r.redactionPolicy ?? null, mono: true }
  ];
}

/** The JSON shown under "details": exactly what the server answered, minus the candidate list. */
export function receiptJson(decision) {
  const d = decision && typeof decision === 'object' ? decision : {};
  return JSON.stringify({ ok: d.ok, status: d.status, selectedCandidateId: d.selectedCandidateId ?? null, receipt: d.receipt ?? null }, null, 2);
}
