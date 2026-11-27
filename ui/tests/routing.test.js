// Unit tests for the Routing view helpers (pure functions; no DOM required).
// Run: node --test ui/tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { t, setLang } from '../app/core/i18n.js';
import '../app/core/strings.js';
import '../app/views/routing/strings.js';
import {
  circuitView, summarize, privacyKey, maxKnownRemaining, quotaView, shortHash, sortReceipts, normalizeScores, flagList, splitReasons
} from '../app/views/routing/table.js';
import { sanitizePolicy, clampTokens, decideBody, decisionView, receiptRows, receiptJson, DEFAULT_POLICY } from '../app/views/routing/simulate.js';

// setLang() touches document.documentElement.lang; Node has no DOM.
globalThis.document = globalThis.document || { documentElement: { lang: 'vi' } };

const candidates = [
  { id: 'a', circuit: 'Closed', quotaState: 'Known', remainingTokens: 480000, reserveTokens: 25000 },
  { id: 'b', circuit: 'HalfOpen', quotaState: 'Stale', remainingTokens: 125000, reserveTokens: 20000 },
  { id: 'c', circuit: 'Open', quotaState: 'Unknown', remainingTokens: null, reserveTokens: 0 },
  { id: 'd', circuit: 'Closed', quotaState: 'Known', remainingTokens: 960000, reserveTokens: 40000 },
  { id: 'e', circuit: 'Weird', quotaState: 'Contradictory', remainingTokens: 5, reserveTokens: 1 }
];

test('circuit mapping and summary counts', () => {
  assert.equal(circuitView('Closed').variant, 'ok');
  assert.equal(circuitView('HalfOpen').variant, 'warn');
  assert.equal(circuitView('Open').variant, 'danger');
  assert.equal(circuitView('Weird').key, 'other');
  assert.deepEqual(summarize(candidates), { total: 5, closed: 2, halfOpen: 1, open: 1 });
  assert.equal(privacyKey('private_vpc'), 'private_vpc');
  assert.equal(privacyKey('nope'), null);
});

test('quota meter scales to the largest Known remaining; Unknown is never 0', () => {
  const max = maxKnownRemaining(candidates);
  assert.equal(max, 960000);
  assert.equal(quotaView(candidates[0], max).pct, 50);
  assert.equal(quotaView(candidates[3], max).pct, 100);
  const stale = quotaView(candidates[1], max);
  assert.equal(stale.kind, 'stale');
  assert.equal(stale.pct, 0);
  assert.equal(stale.remaining, 125000);
  const unknown = quotaView(candidates[2], max);
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.remaining, null);
  assert.equal(quotaView(candidates[4], max).kind, 'contradictory');
  assert.equal(quotaView({ quotaState: 'Mystery', remainingTokens: 7 }, max).remaining, null);
});

test('hash shortening and receipt order', () => {
  assert.equal(shortHash('sha256:8880f710b9569533'), '8880f710…9533');
  assert.equal(shortHash('abc'), 'abc');
  assert.equal(shortHash(null), '—');
  const sorted = sortReceipts([{ receiptId: 'rdec-1', decidedAt: 1 }, { receiptId: 'rdec-2', decidedAt: 2 }]);
  assert.equal(sorted[0].receiptId, 'rdec-2');
});

test('score rows: scale fits every bar, eligible first, rejected bars empty', () => {
  const { rows, scale } = normalizeScores([
    { candidateId: 'x', eligible: false, totalScore: 0, totalScoreBps: 0, rejectedReason: 'circuit_open, quota_stale' },
    { candidateId: 'y', eligible: true, totalScore: 100, totalScoreBps: 11244, capabilityScore: 40, privacyScore: 20, quotaScore: 6, latencyScore: 16, reliabilityScore: 30 },
    { candidateId: 'z', eligible: true, totalScore: 100, totalScoreBps: 12758, capabilityScore: 40, privacyScore: 20, quotaScore: 18, latencyScore: 19, reliabilityScore: 30 }
  ]);
  assert.equal(scale, 127);
  assert.deepEqual(rows.map((r) => r.candidateId), ['z', 'y', 'x']);
  const widths = rows[0].segments.reduce((a, s) => a + s.pct, 0);
  assert.ok(widths <= 100.5 && widths > 99);
  assert.equal(rows[2].segments.every((s) => s.pct === 0), true);
  assert.deepEqual(splitReasons('a, b'), ['a', 'b']);
  assert.deepEqual(flagList({ vision: true, audio: false }), [['audio', false], ['vision', true]]);
});

test('policy sanitising and the decide body', () => {
  assert.deepEqual(sanitizePolicy(null), DEFAULT_POLICY);
  assert.equal(sanitizePolicy({ estimatedTokens: 5 }).estimatedTokens, 64);
  assert.equal(sanitizePolicy({ estimatedTokens: 1e9 }).estimatedTokens, 120000);
  assert.equal(sanitizePolicy({ taskClass: 'evil', privacyTier: 'evil' }).taskClass, 'code_generation');
  assert.equal(clampTokens('abc', 77), 77);
  const body = decideBody({ ...DEFAULT_POLICY, junk: 1 }, { tripCandidate: 'a' });
  assert.deepEqual(Object.keys(body).sort(), ['estimatedTokens', 'privacyTier', 'requireStreaming', 'taskClass', 'tripCandidate']);
  assert.equal(decideBody(DEFAULT_POLICY, { simulate: true }).simulate, true);
  assert.equal(decisionView({ ok: true, allowed: true, status: 'ROUTED' }).variant, 'ok');
  assert.equal(decisionView({ ok: true, status: 'ROUTED_DETERMINISTIC' }).variant, 'ok');
  assert.equal(decisionView({ ok: true, status: 'SIMULATED_DETERMINISTIC' }).variant, 'ok');
  assert.equal(decisionView({ ok: true, allowed: false, status: 'FENCED' }).variant, 'danger');
  assert.equal(decisionView({ ok: false, status: 'FENCED_NO_ELIGIBLE_ROUTE' }).variant, 'danger');
  assert.equal(decisionView({ ok: false, status: 'FENCED_OPERATOR_RECOVERY_REQUIRED' }).variant, 'danger');
});

test('receipt rows keep null as null and JSON omits candidates', () => {
  const rows = receiptRows({ receiptId: 'r', reservationId: null, estimatedCostMicrounits: null, secretsExposed: 0 });
  assert.equal(rows.find((r) => r.key === 'reservationId').value, null);
  assert.equal(rows.find((r) => r.key === 'secretsExposed').value, 0);
  const json = JSON.parse(receiptJson({ ok: false, status: 'X', selectedCandidateId: null, candidates: [1], receipt: { receiptId: 'r' } }));
  assert.equal('candidates' in json, false);
  assert.equal(json.receipt.receiptId, 'r');
});

test('every routing string key used in the sources exists in vi and en', () => {
  const src = readFileSync(new URL('../app/views/routing/index.js', import.meta.url), 'utf8');
  const keys = new Set([...src.matchAll(/\bt\('(routing\.[\w.]+)'/g)].map((m) => m[1]));
  for (const k of ['closed', 'halfOpen', 'open']) keys.add(`routing.circuit.${k}`);
  for (const k of ['strict_local_zero_retention', 'enterprise_zdr', 'private_vpc', 'standard_cloud']) keys.add(`routing.privacy.${k}`);
  for (const k of ['code_generation', 'architecture_synthesis', 'math_derivation', 'multimodal_vision', 'fast_triage']) keys.add(`routing.task.${k}`);
  for (const k of ['capability', 'privacy', 'quota', 'latency', 'reliability']) keys.add(`routing.scores.${k}`);
  for (const k of ['sim', 'trip', 'reset']) keys.add(`routing.scores.kind.${k}`);
  for (const k of ['receiptId', 'sequenceId', 'reservationId', 'policyClass', 'policyHash', 'reservedTokens', 'promptRedacted', 'secretsExposed', 'estimatedCostMicrounits', 'schemaVersion', 'redactionPolicy']) keys.add(`routing.rk.${k}`);
  for (const k of ['providers', 'active', 'retry', 'open']) keys.add(`routing.tile.${k}`);
  assert.ok(keys.size > 80);
  for (const lang of ['vi', 'en']) {
    setLang(lang);
    for (const key of keys) assert.notEqual(t(key), key, `${lang}: ${key}`);
  }
  setLang('vi');
});
