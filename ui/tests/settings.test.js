// Unit tests for the Settings view (pure helpers + string completeness). Run: node --test ui/tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

globalThis.document = globalThis.document || { documentElement: { lang: 'vi', getAttribute: () => null } };

const { t, setLang } = await import('../app/core/i18n.js');
await import('../app/views/settings/strings.js');
const h = await import('../app/views/settings/helpers.js');
const { capabilityMatrixHtml } = await import('../app/views/settings/capabilities.js');
const { ApiError } = await import('../app/api.js');

const chat = (n, extra = {}) => JSON.stringify({ v: 1, messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: 'user', markdown: 'xin chào' })), ...extra });

test('summarizeLocalChat counts sessions with messages, messages and UTF-8 bytes', () => {
  const records = [
    { key: 'omnia.ui.chat.a', raw: chat(2) },
    { key: 'omnia.ui.chat.b', raw: chat(0, { draft: { text: 'dở dang' } }) },
    { key: 'omnia.ui.chat.c', raw: chat(1) }
  ];
  const s = h.summarizeLocalChat(records);
  assert.equal(s.records, 3);
  assert.equal(s.sessions, 2);
  assert.equal(s.messages, 3);
  assert.equal(s.unreadable, 0);
  const expected = records.reduce((sum, r) => sum + new TextEncoder().encode(r.key + r.raw).length, 0);
  assert.equal(s.bytes, expected);
});

test('summarizeLocalChat counts bytes, not characters, for Vietnamese text', () => {
  const raw = JSON.stringify({ messages: [{ markdown: 'ệ' }] });
  const s = h.summarizeLocalChat([{ key: 'k', raw }]);
  assert.equal(s.bytes, 1 + raw.length + 2); // "ệ" is 3 bytes but 1 character
});

test('summarizeLocalChat tolerates corrupt, empty and malformed records', () => {
  const s = h.summarizeLocalChat([
    { key: 'omnia.ui.chat.x', raw: '{not json' },
    { key: 'omnia.ui.chat.y', raw: '' },
    { key: 'omnia.ui.chat.z', raw: 'null' },
    null,
    { raw: 'x' }
  ]);
  assert.equal(s.records, 3);
  assert.equal(s.unreadable, 2);
  assert.equal(s.sessions, 0);
  assert.deepEqual(h.summarizeLocalChat([]), { records: 0, sessions: 0, messages: 0, bytes: 0, unreadable: 0 });
  assert.deepEqual(h.summarizeLocalChat(undefined), { records: 0, sessions: 0, messages: 0, bytes: 0, unreadable: 0 });
});

test('buildExport keeps parsed data, preserves unreadable raw text and ignores foreign keys', () => {
  const now = new Date('2026-11-13T10:00:00.000Z');
  const doc = h.buildExport(
    [
      { key: 'omnia.ui.chat.b', raw: chat(1) },
      { key: 'omnia.ui.chat.a', raw: '{broken' },
      { key: 'omnia.ui.prefs', raw: '{}' }
    ],
    now
  );
  assert.equal(doc.app, 'omnia-studio');
  assert.equal(doc.version, 1);
  assert.equal(doc.exportedAt, '2026-11-13T10:00:00.000Z');
  assert.deepEqual(doc.sessions.map((s) => s.sessionId), ['a', 'b']);
  assert.equal(doc.sessions[0].raw, '{broken');
  assert.equal(doc.sessions[1].data.messages.length, 1);
  assert.doesNotThrow(() => JSON.stringify(doc));
});

test('exportFileName uses the local calendar day, zero padded', () => {
  assert.equal(h.exportFileName(new Date(2026, 10, 3, 23, 59)), 'omnia-local-chat-20261103.json');
  assert.equal(h.exportFileName(new Date(2026, 0, 31, 0, 0)), 'omnia-local-chat-20260131.json');
});

test('diagnosticRows maps /api/health and omits nothing silently', () => {
  const health = { engine: 'Omnia Full Native Rust', compiler: 'rustc 1.90', crateCount: 17, pid: 736, workingSetBytes: 8073216, binaryBytes: 687616, skillCount: 22, peerCount: 6, rustFiles: 112 };
  const rows = h.diagnosticRows(health, '127.0.0.1:8787');
  assert.deepEqual(rows.map((r) => r.id), ['host', 'engine', 'compiler', 'crateCount', 'pid', 'workingSet', 'binary', 'skillsPeers', 'rustFiles']);
  assert.deepEqual(rows.find((r) => r.id === 'skillsPeers').value, [22, 6]);
  assert.equal(rows.find((r) => r.id === 'crateCount').value, 17);
  assert.equal(rows.find((r) => r.id === 'rustFiles').value, 112);
  assert.deepEqual(h.diagnosticRows(null, ''), []);
  assert.deepEqual(h.diagnosticRows(null, 'h:1').map((r) => r.id), ['host']);
});

test('connectionMeta covers every connection status', () => {
  assert.equal(h.connectionMeta('online').variant, 'ok');
  assert.equal(h.connectionMeta('offline').variant, 'danger');
  assert.equal(h.connectionMeta('connecting').variant, 'warn');
  assert.equal(h.connectionMeta('anything').variant, 'warn');
});

test('shortcut table matches the documented keys', () => {
  assert.deepEqual(h.SHORTCUTS.map((s) => s.id), ['palette', 'sidebar', 'inspector', 'views', 'send', 'theme', 'escape']);
  assert.deepEqual(h.SHORTCUTS.find((s) => s.id === 'views').keys, ['Alt 1', 'Alt 5']);
});

test('swatch halves: system mixes dark and light', () => {
  assert.deepEqual(h.THEME_SWATCH.system, ['dark', 'light']);
  assert.deepEqual(Object.keys(h.THEME_SWATCH), h.THEMES);
});

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'views', 'settings');

function usedKeys() {
  const keys = new Set();
  for (const file of ['index.js', 'helpers.js', 'capabilities.js']) {
    const source = readFileSync(path.join(dir, file), 'utf8');
    for (const match of source.matchAll(/['"`](settings\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)['"`]/g)) keys.add(match[1]);
  }
  return keys;
}

const DYNAMIC = [
  ...h.SECTIONS.map((s) => `settings.title.${s}`),
  ...h.SHORTCUTS.map((s) => `settings.key.${s.id}`),
  ...h.diagnosticRows({}, 'h').map((r) => `settings.diag.${r.id}`),
  ...h.THEMES.map((id) => `settings.theme${id[0].toUpperCase()}${id.slice(1)}`),
  'settings.densityComfortable',
  'settings.densityCompact',
  'settings.healthHealthy',
  'settings.healthDegraded',
  'settings.healthUnhealthy',
  'settings.healthUnknown',
  'settings.capStatusReady',
  'settings.capStatusDegraded',
  'settings.capStatusUnavailable',
  'settings.capStatusDisabled',
  'settings.capRemediateRuntime',
  'settings.capRemediateGeneric'
];

for (const lang of ['vi', 'en']) {
  test(`every settings string key resolves in ${lang}`, () => {
    setLang(lang);
    const missing = [];
    for (const key of new Set([...usedKeys(), ...DYNAMIC])) {
      if (t(key, { n: 1, sessions: 1, messages: 1, size: 'x', name: 'x', ready: 1, total: 2, source: 'v1' }) === key) missing.push(key);
    }
    assert.deepEqual(missing, []);
  });
}

test('local summary string interpolates all parts in both languages', () => {
  for (const lang of ['vi', 'en']) {
    setLang(lang);
    const text = t('settings.localSummary', { sessions: 3, messages: 6, size: '18 KB' });
    assert.ok(text.includes('3') && text.includes('6') && text.includes('18 KB'), text);
  }
});

// ---------------------------------------------------------------------------
// AUD-25: separate transport vs service health and live Capability Matrix
// ---------------------------------------------------------------------------

test('AUD-25: serviceHealthMeta separates transport reachability from service health', () => {
  assert.equal(h.serviceHealthMeta({ status: 'online', serviceHealth: 'healthy' }).state, 'healthy');
  assert.equal(h.serviceHealthMeta({ status: 'online', serviceHealth: 'unhealthy' }).state, 'unhealthy');
  assert.equal(h.serviceHealthMeta({ status: 'online', serviceHealth: 'unhealthy' }).variant, 'danger');
  assert.equal(h.serviceHealthMeta({ status: 'online', serviceHealth: 'degraded' }).state, 'degraded');
  assert.equal(h.serviceHealthMeta({ status: 'offline', serviceHealth: 'healthy' }).state, 'unknown');
});

test('AUD-25: normalizeCapabilityRows normalizes omnia.capabilities.v1 with remediation and summary', () => {
  const payload = {
    ok: true,
    schema: 'omnia.capabilities.v1',
    capabilities: [
      { id: 'sessions', enabled: true, endpoint: '/api/sessions', backend: 'winsqlite3' },
      { id: 'runtime_proxy', enabled: false, timeoutMs: 3000 },
      { id: 'media_capture', status: 'degraded', endpoint: '/api/media/capabilities', remediation: 'Enable desktop capture host' }
    ]
  };
  const rows = h.normalizeCapabilityRows(payload, 1700000000000);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[0].detail, 'winsqlite3');
  assert.equal(rows[0].remediationKey, '');
  assert.equal(rows[1].status, 'unavailable');
  assert.equal(rows[1].remediationKey, 'settings.capRemediateRuntime');
  assert.equal(rows[2].status, 'degraded');
  assert.equal(rows[2].remediation, 'Enable desktop capture host');
  assert.deepEqual(h.summarizeCapabilities(rows), { total: 3, ready: 1, degraded: 1, unavailable: 1 });
});

test('AUD-25: capabilityMatrixHtml renders table, remediation, error state and escapes HTML', () => {
  setLang('en');
  const rows = h.normalizeCapabilityRows({
    schema: 'omnia.capabilities.v1',
    capabilities: [
      { id: 'sessions', enabled: true, endpoint: '/api/sessions', backend: 'winsqlite3' },
      { id: 'runtime_proxy', enabled: false, remediation: '<script>alert(1)</script>Start omnia-runtime' }
    ]
  }, Date.UTC(2026, 10, 28, 10, 0, 0));
  const out = String(capabilityMatrixHtml({
    status: 'ready',
    schema: 'omnia.capabilities.v1',
    rows,
    error: null,
    fetchedAt: Date.UTC(2026, 10, 28, 10, 0, 0)
  }));
  assert.match(out, /data-role="capability-matrix"/);
  assert.match(out, /1\/2 ready/);
  assert.match(out, /data-cap-status="ready"/);
  assert.match(out, /data-cap-status="unavailable"/);
  assert.match(out, /\/api\/sessions/);
  assert.equal(out.includes('<script>'), false);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;Start omnia-runtime/);

  const errOut = String(capabilityMatrixHtml({
    status: 'error',
    schema: '',
    rows: [],
    error: new ApiError({ status: 503, code: 'unavailable', path: '/api/capabilities' }),
    fetchedAt: 0
  }));
  assert.match(errOut, /Could not read GET \/api\/capabilities/);
  setLang('vi');
});
