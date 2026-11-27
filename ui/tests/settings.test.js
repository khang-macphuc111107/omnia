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
  const health = { engine: 'Omnia Native C++20', compiler: 'MSVC 14.51', cplusplus: 202002, pid: 736, workingSetBytes: 8073216, binaryBytes: 687616, skillCount: 13, peerCount: 6, rustFiles: 0 };
  const rows = h.diagnosticRows(health, '127.0.0.1:8787');
  assert.deepEqual(rows.map((r) => r.id), ['host', 'engine', 'compiler', 'cplusplus', 'pid', 'workingSet', 'binary', 'skillsPeers', 'rustFiles']);
  assert.deepEqual(rows.find((r) => r.id === 'skillsPeers').value, [13, 6]);
  assert.equal(rows.find((r) => r.id === 'rustFiles').value, 0);
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
  for (const file of ['index.js', 'helpers.js']) {
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
  'settings.densityCompact'
];

for (const lang of ['vi', 'en']) {
  test(`every settings string key resolves in ${lang}`, () => {
    setLang(lang);
    const missing = [];
    for (const key of new Set([...usedKeys(), ...DYNAMIC])) {
      if (t(key, { n: 1, sessions: 1, messages: 1, size: 'x', name: 'x' }) === key) missing.push(key);
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
