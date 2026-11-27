// Unit tests for the platform layer (pure functions only; no DOM required).
// Run: node --test ui/tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { html, raw, escapeHtml, cx, join, isSafe } from '../app/core/dom.js';
import { registerStrings, t, fmtNumber, fmtBytes, fold } from '../app/core/i18n.js';
import { parseRoute, buildHash } from '../app/core/router.js';
import { createStore } from '../app/core/store.js';
import { validateMemoryNamespace, validateMemoryKey, ApiError, describeError } from '../app/api.js';
import { scoreCommand } from '../app/core/palette.js';
import '../app/core/strings.js';

test('html escapes interpolated text and attributes', () => {
  const evil = '<img src=x onerror="alert(1)">';
  const out = html`<p title="${evil}">${evil}</p>`;
  assert.ok(isSafe(out));
  assert.equal(String(out).includes('<img'), false);
  assert.equal(String(out), `<p title="${escapeHtml(evil)}">${escapeHtml(evil)}</p>`);
});

test('html keeps SafeHtml, flattens arrays, drops null and renders booleans', () => {
  const items = ['a', 'b'].map((x) => html`<li>${x}</li>`);
  assert.equal(String(html`<ul>${items}</ul>`), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(String(html`<i>${null}${undefined}</i>`), '<i></i>');
  assert.equal(String(html`<b aria-pressed="${true}">${false}</b>`), '<b aria-pressed="true">false</b>');
  assert.equal(String(html`${raw('<svg></svg>')}`), '<svg></svg>');
  assert.equal(String(join([html`<a></a>`, 'x<'], ', ')), '<a></a>, x&lt;');
});

test('cx builds class lists', () => {
  assert.equal(cx('btn', { 'btn--primary': true, 'btn--sm': false }, null, 'x'), 'btn btn--primary x');
});

test('i18n falls back to English then to the key and fills placeholders', () => {
  registerStrings('test', { vi: { hello: 'Xin chào {name}' }, en: { hello: 'Hello {name}', onlyEn: 'English only', 'n.one': 'one item', 'n.other': '{count} items' } });
  assert.equal(t('test.hello', { name: 'An' }), 'Xin chào An');
  assert.equal(t('test.onlyEn'), 'English only');
  assert.equal(t('test.missing'), 'test.missing');
  assert.equal(t('test.n', { count: 1 }), 'one item');
  assert.equal(t('test.n', { count: 3 }), '3 items');
});

test('number and byte formatting follow the Vietnamese locale by default', () => {
  assert.equal(fmtNumber(4096), '4.096');
  assert.equal(fmtBytes(4820), '4,7 KB');
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtNumber(Number.NaN), '—');
});

test('fold removes Vietnamese diacritics for matching', () => {
  assert.equal(fold('Định tuyến'), 'dinh tuyen');
  assert.equal(fold('TIẾNG VIỆT'), 'tieng viet');
});

test('parseRoute and buildHash round-trip', () => {
  assert.deepEqual(parseRoute('#/chat/sess-1'), { view: 'chat', params: ['sess-1'], hash: '#/chat/sess-1' });
  assert.deepEqual(parseRoute(''), { view: '', params: [], hash: '#/' });
  assert.equal(buildHash('knowledge', 'memory'), '#/knowledge/memory');
  assert.equal(buildHash('chat', 'a b/c'), '#/chat/a%20b%2Fc');
  assert.deepEqual(parseRoute(buildHash('chat', 'a b/c')).params, ['a b/c']);
});

test('createStore merges, notifies and unsubscribes', () => {
  const store = createStore({ a: 1, b: 2 });
  const seen = [];
  const stop = store.subscribe((state, prev) => seen.push([prev.a, state.a]));
  store.set({ a: 5 });
  store.set((s) => ({ ...s, a: s.a + 1 }));
  stop();
  store.set({ a: 99 });
  assert.deepEqual(seen, [[1, 5], [5, 6]]);
  assert.equal(store.get().b, 2);
});

test('memory namespace and key validation mirror the server rules', () => {
  assert.equal(validateMemoryNamespace('architecture/cpp20-core'), null);
  assert.equal(validateMemoryNamespace(''), 'empty');
  assert.equal(validateMemoryNamespace('a/../b'), 'dot_dot');
  assert.equal(validateMemoryNamespace('a/b/c/d/e/f/g/h/i'), 'too_deep');
  assert.equal(validateMemoryNamespace('ghi-chú'), 'bad_chars');
  assert.equal(validateMemoryNamespace('/lead'), 'bad_chars');
  assert.equal(validateMemoryKey('origin-guard'), null);
  assert.equal(validateMemoryKey('a/b'), 'bad_chars');
});

test('describeError maps known codes and falls back for unknown ones', () => {
  assert.equal(describeError(new ApiError({ code: 'network' })), 'Không kết nối được omnia-studio.exe.');
  assert.equal(describeError(new ApiError({ code: 'weird_code' })), 'Lỗi không xác định (weird_code).');
  assert.equal(describeError(new ApiError({ code: 'graph_send_rejected', message: 'Unknown agent: x' })), 'Server từ chối tin nhắn: Unknown agent: x');
});

test('palette scoring is accent-insensitive and prefers substring matches', () => {
  const routing = { title: 'Mở Định tuyến', keywords: 'routing', group: 'Điều hướng' };
  const memory = { title: 'Mở Tri thức', keywords: 'knowledge', group: 'Điều hướng' };
  assert.ok(scoreCommand(routing, 'dinh tuyen') > scoreCommand(memory, 'dinh tuyen'));
  assert.equal(scoreCommand(memory, 'dinh tuyen'), 0);
  assert.ok(scoreCommand(routing, '') > 0);
});
