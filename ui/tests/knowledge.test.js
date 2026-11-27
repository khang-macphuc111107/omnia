// Unit tests for the Knowledge view (pure helpers + string completeness). Run: node --test ui/tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

globalThis.document = globalThis.document || { documentElement: { lang: 'vi', getAttribute: () => null } };

const { t, setLang } = await import('../app/core/i18n.js');
await import('../app/views/knowledge/strings.js');
const h = await import('../app/views/knowledge/helpers.js');

const entries = [
  { id: 'architecture/cpp20-core/winsqlite3-wal-lease', namespace: 'architecture/cpp20-core', key: 'winsqlite3-wal-lease', content: 'SessionStore uses WAL', tier: 'Durable', updatedAt: 300 },
  { id: 'architecture/win32-uia/modal-32770-cbt-hook', namespace: 'architecture/win32-uia', key: 'modal-32770-cbt-hook', content: 'Hook gắn IInvokeProvider', tier: 'Durable', updatedAt: 200 },
  { id: 'workspace/ui-atelier/contrast-floor', namespace: 'workspace/ui-atelier', key: 'contrast-floor', content: 'Độ tương phản tối thiểu 4.5', tier: 'Working', updatedAt: 400 },
  { id: 'lessons/zero-drop', namespace: 'lessons', key: 'zero-drop', content: 'Steer queue', tier: 'Durable', updatedAt: 100 }
];

test('tabFromRoute accepts only known tabs', () => {
  assert.equal(h.tabFromRoute({ params: ['skills'] }), 'skills');
  assert.equal(h.tabFromRoute({ params: ['rag', 'x'] }), 'rag');
  assert.equal(h.tabFromRoute({ params: [] }), null);
  assert.equal(h.tabFromRoute({ params: ['nope'] }), null);
  assert.equal(h.tabFromRoute(null), null);
});

test('buildNamespaceTree counts entries at and below each node, parents first', () => {
  const tree = h.buildNamespaceTree(entries);
  assert.deepEqual(
    tree.map((n) => [n.path, n.depth, n.count]),
    [
      ['architecture', 0, 2],
      ['architecture/cpp20-core', 1, 1],
      ['architecture/win32-uia', 1, 1],
      ['lessons', 0, 1],
      ['workspace', 0, 1],
      ['workspace/ui-atelier', 1, 1]
    ]
  );
  assert.equal(tree[1].name, 'cpp20-core');
  assert.deepEqual(h.buildNamespaceTree([]), []);
});

test('tree order is segment-wise, not string-wise ("a-b" must not split "a" and "a/b")', () => {
  const tree = h.buildNamespaceTree([
    { namespace: 'a/b' },
    { namespace: 'a-b' },
    { namespace: 'a' }
  ]);
  assert.deepEqual(tree.map((n) => n.path), ['a', 'a/b', 'a-b']);
});

test('filterEntries combines namespace prefix and accent-insensitive text, newest first', () => {
  assert.deepEqual(h.filterEntries(entries, {}).map((e) => e.key), ['contrast-floor', 'winsqlite3-wal-lease', 'modal-32770-cbt-hook', 'zero-drop']);
  assert.deepEqual(h.filterEntries(entries, { namespace: 'architecture' }).map((e) => e.key), ['winsqlite3-wal-lease', 'modal-32770-cbt-hook']);
  assert.deepEqual(h.filterEntries(entries, { namespace: 'architecture/win32-uia' }).map((e) => e.key), ['modal-32770-cbt-hook']);
  assert.deepEqual(h.filterEntries(entries, { text: 'tuong phan' }).map((e) => e.key), ['contrast-floor']);
  assert.deepEqual(h.filterEntries(entries, { text: 'working' }).map((e) => e.key), ['contrast-floor']);
  assert.deepEqual(h.filterEntries(entries, { text: 'hook uia' }).map((e) => e.key), ['modal-32770-cbt-hook']);
  assert.deepEqual(h.filterEntries(entries, { namespace: 'lessons', text: 'wal' }), []);
  // the namespace "arch" must not match "architecture"
  assert.deepEqual(h.filterEntries(entries, { namespace: 'arch' }), []);
});

test('shortSha shortens only long digests', () => {
  assert.equal(h.shortSha('d8ead83a45f4a587251ebf8745f2e83bb177a99d194562f1e4143ca726871738'), 'd8ead83a…1738');
  assert.equal(h.shortSha('abc'), 'abc');
  assert.equal(h.shortSha(undefined), '');
});

test('tierMeta maps Durable to info and Working to warn', () => {
  assert.equal(h.tierMeta('Durable').variant, 'info');
  assert.equal(h.tierMeta('Working').variant, 'warn');
  assert.equal(h.tierMeta('whatever').variant, 'info');
});

test('memoryFieldIssue maps validator codes to specific, user-facing issues', () => {
  assert.equal(h.memoryFieldIssue('namespace', 'architecture/cpp20-core'), null);
  assert.equal(h.memoryFieldIssue('key', 'winsqlite3.wal_lease-1'), null);
  assert.equal(h.memoryFieldIssue('namespace', ''), 'empty');
  assert.equal(h.memoryFieldIssue('key', ''), 'empty');
  assert.equal(h.memoryFieldIssue('namespace', 'a/../b'), 'dot_dot');
  assert.equal(h.memoryFieldIssue('namespace', 'a/b/c/d/e/f/g/h/i'), 'too_deep');
  assert.equal(h.memoryFieldIssue('namespace', 'x'.repeat(257)), 'too_long');
  assert.equal(h.memoryFieldIssue('namespace', 'ghi-chú/mục'), 'diacritics');
  assert.equal(h.memoryFieldIssue('key', 'ghi-chú'), 'diacritics');
  assert.equal(h.memoryFieldIssue('key', 'đ'), 'diacritics');
  assert.equal(h.memoryFieldIssue('namespace', '/lead'), 'bad_slash');
  assert.equal(h.memoryFieldIssue('namespace', 'trail/'), 'bad_slash');
  assert.equal(h.memoryFieldIssue('namespace', 'a//b'), 'bad_slash');
  assert.equal(h.memoryFieldIssue('key', 'a/b'), 'key_slash');
  assert.equal(h.memoryFieldIssue('key', 'k'.repeat(65)), 'segment_long');
  assert.equal(h.memoryFieldIssue('namespace', `ok/${'s'.repeat(65)}`), 'segment_long');
  assert.equal(h.memoryFieldIssue('key', 'has space'), 'bad_chars');
  assert.equal(h.memoryFieldIssue('namespace', 'has space'), 'bad_chars');
});

test('validateMemoryForm is valid only when both fields are valid', () => {
  assert.deepEqual(h.validateMemoryForm({ namespace: 'a/b', key: 'k' }), { namespace: null, key: null, valid: true });
  assert.equal(h.validateMemoryForm({ namespace: 'a/b', key: 'ghi chú' }).valid, false);
  assert.equal(h.validateMemoryForm({ namespace: '', key: 'k' }).namespace, 'empty');
});

test('offendingChars lists unique non-ASCII characters in order', () => {
  assert.equal(h.offendingChars('ghi-chú'), 'ú');
  assert.equal(h.offendingChars('ôô-ê'), 'ô ê');
  assert.equal(h.offendingChars('plain'), '');
});

test('mergeReceipts de-duplicates by id and sorts newest first', () => {
  const server = [{ receiptId: 'r1', erasedAt: 10 }, { receiptId: 'r2', erasedAt: 30 }];
  const local = [{ receiptId: 'r2', erasedAt: 30 }, { receiptId: 'r3', erasedAt: 20 }];
  assert.deepEqual(h.mergeReceipts(server, local).map((r) => r.receiptId), ['r2', 'r3', 'r1']);
  assert.deepEqual(h.mergeReceipts(undefined, undefined), []);
});

test('normalizeQuery collapses whitespace', () => {
  assert.equal(h.normalizeQuery('  graph   walk \n'), 'graph walk');
  assert.equal(h.normalizeQuery(null), '');
});

test('uncertaintyPercent clamps to 0–100', () => {
  assert.equal(h.uncertaintyPercent(0.32), 32);
  assert.equal(h.uncertaintyPercent(1.4), 100);
  assert.equal(h.uncertaintyPercent(-1), 0);
  assert.equal(h.uncertaintyPercent('x'), 0);
});

test('provenanceVariant and languageLabelKey', () => {
  assert.equal(h.provenanceVariant('EXTRACTED'), 'ok');
  assert.equal(h.provenanceVariant('inferred'), 'info');
  assert.equal(h.provenanceVariant('AMBIGUOUS'), 'warn');
  assert.equal(h.provenanceVariant('???'), '');
  assert.equal(h.languageLabelKey('bilingual'), 'knowledge.lang.bilingual');
  assert.equal(h.languageLabelKey('fr'), 'knowledge.lang.unknown');
  assert.equal(h.humanizeCode('below_relevance-threshold'), 'below relevance threshold');
});

test('RAG samples cover Vietnamese and English and are non-empty', () => {
  assert.equal(h.RAG_SAMPLES.length, 3);
  assert.ok(h.RAG_SAMPLES.every((s) => s.query.trim().length > 10));
  assert.ok(h.RAG_SAMPLES.some((s) => /[à-ỹ]/i.test(s.query)));
  assert.ok(h.RAG_SAMPLES.some((s) => /^How /.test(s.query)));
});

// ---------------------------------------------------------------------------
// Strings: every key used by the view exists in both languages
// ---------------------------------------------------------------------------

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'views', 'knowledge');

function usedKeys() {
  const keys = new Set();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'strings.js')) {
    const source = readFileSync(path.join(dir, file), 'utf8');
    for (const match of source.matchAll(/['"`](knowledge\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)['"`]/g)) keys.add(match[1]);
  }
  return keys;
}

const DYNAMIC = [
  ...['empty', 'too_long', 'too_deep', 'dot_dot', 'diacritics', 'bad_slash', 'key_slash', 'segment_long', 'bad_chars'].map((c) => `knowledge.issue.${c}`),
  ...['vi', 'en', 'bilingual', 'unknown'].map((l) => `knowledge.lang.${l}`),
  'knowledge.angle.specification_contract',
  'knowledge.angle.cpp20_implementation',
  'knowledge.angle.failure_and_security_edges',
  'knowledge.reason.below_relevance_threshold',
  'knowledge.reason.quarantined_ambiguous_provenance',
  'knowledge.reason.superseded_historical_artifact'
];

for (const lang of ['vi', 'en']) {
  test(`every knowledge string key resolves in ${lang}`, () => {
    setLang(lang);
    const missing = [];
    for (const key of new Set([...usedKeys(), ...DYNAMIC])) {
      // plural families are looked up with a count
      const probe = ['knowledge.entryCount', 'knowledge.skillsAll', 'knowledge.skillsFound'].includes(key) ? t(key, { count: 2, q: 'x' }) : t(key);
      if (probe === key) missing.push(key);
    }
    assert.deepEqual(missing, []);
  });
}

test('vi and en are not accidentally identical for UI chrome', () => {
  setLang('vi');
  const vi = t('knowledge.tabMemory');
  setLang('en');
  assert.notEqual(vi, t('knowledge.tabMemory'));
});

test('the diacritics message names the offending characters and is worded per language', () => {
  setLang('vi');
  assert.match(t('knowledge.issue.diacritics', { field: 'Key', chars: 'ú' }), /ASCII.*ú/);
  setLang('en');
  assert.match(t('knowledge.issue.diacritics', { field: 'Key', chars: 'ú' }), /ASCII only.*ú/);
});

test('plural entry counts', () => {
  setLang('en');
  assert.equal(t('knowledge.entryCount', { count: 1 }), '1 entry');
  assert.equal(t('knowledge.entryCount', { count: 4 }), '4 entries');
  setLang('vi');
  assert.equal(t('knowledge.entryCount', { count: 4 }), '4 mục');
});
