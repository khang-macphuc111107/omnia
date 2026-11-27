import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearChatRecords } from '../app/views/settings/local-data.js';

function fixture(t, mode = '') {
  const original = globalThis.window;
  t.after(() => { if (original === undefined) delete globalThis.window; else globalThis.window = original; });
  const rows = new Map([['omnia.ui.chat.a', '{}'], ['omnia.ui.chat.b', '{}'], ['omnia.ui.theme', 'dark']]);
  globalThis.window = { localStorage: {
    get length() { if (mode === 'unreadable') throw new Error('blocked'); return rows.size; },
    key: (i) => [...rows.keys()][i],
    getItem: (key) => rows.get(key) ?? null,
    removeItem: (key) => {
      if (key.endsWith('.b') && mode === 'throw') throw new Error('blocked');
      if (key.endsWith('.b') && mode === 'noop') return;
      rows.delete(key);
    }
  } };
  return rows;
}

test('erase reports actual removals and preserves unrelated keys', (t) => {
  const rows = fixture(t);
  assert.deepEqual(clearChatRecords(), { removed: 2, failed: 0, remaining: 0, verified: true });
  assert.equal(rows.get('omnia.ui.theme'), 'dark');
});
for (const mode of ['throw', 'noop']) {
  test(`erase reports partial failure when remove ${mode}`, (t) => {
    const rows = fixture(t, mode);
    assert.deepEqual(clearChatRecords(), { removed: 1, failed: 1, remaining: 1, verified: true });
    assert.ok(rows.has('omnia.ui.chat.b'));
  });
}
test('unreadable storage is unverified, never a successful empty erase', (t) => {
  fixture(t, 'unreadable');
  assert.deepEqual(clearChatRecords(), { removed: 0, failed: 0, remaining: null, verified: false });
});
