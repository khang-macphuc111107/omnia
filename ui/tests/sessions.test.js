import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../app/api.js';

const row = (id, revision = 1) => ({ id, title: id, updatedAt: 100, revision });
const page = (items, nextCursor = null) => ({ sessions: items, nextCursor, totalCount: 56 });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let serial = 0;
async function setup(t, activeId = null) {
  const original = { ...api.sessions };
  t.after(() => { Object.assign(api.sessions, original); });
  const mod = await import(`../app/core/sessions.js?test=${++serial}`);
  mod.sessions.set({ items: [row('old')], activeId, status: 'ready' });
  return mod;
}

test('a late list cannot remove a newly created session or change its selection', async (t) => {
  const mod = await setup(t, 'old');
  const pending = deferred();
  let signal;
  api.sessions.list = (opts) => { signal = opts?.signal; return pending.promise; };
  api.sessions.create = async () => ({ ...page([row('new'), row('old')]), session: row('new') });
  const loading = mod.loadSessions();
  await mod.createSession({ title: 'new' });
  pending.resolve(page([row('old')]));
  await loading;
  assert.equal(mod.sessions.get().activeId, 'new');
  assert.ok(mod.findSession('new'));
  assert.equal(signal?.aborted, true);
});

test('newer refresh wins even if an older request fails later', async (t) => {
  const mod = await setup(t);
  const pending = deferred();
  api.sessions.list = () => pending.promise;
  const first = mod.loadSessions();
  api.sessions.list = async () => page([row('fresh')]);
  await mod.loadSessions();
  pending.reject(new ApiError({ code: 'network' }));
  await first;
  assert.equal(mod.sessions.get().status, 'ready');
  assert.deepEqual(mod.sessions.get().items.map((s) => s.id), ['fresh']);
});

test('load more follows the opaque cursor, merges revisions, and retains pages on error', async (t) => {
  const mod = await setup(t);
  api.sessions.list = async () => page([row('a', 2)], 'cursor-1');
  await mod.loadSessions();
  api.sessions.list = async (opts) => {
    assert.equal(opts.cursor, 'cursor-1');
    return page([row('a', 1), row('b')], 'cursor-2');
  };
  await mod.loadMoreSessions();
  assert.deepEqual(mod.sessions.get().items.map((s) => s.id), ['b', 'a']); // timestamp ties: ID descending
  assert.equal(mod.findSession('a').revision, 2);
  api.sessions.list = async () => { throw new ApiError({ code: 'network' }); };
  await mod.loadMoreSessions();
  assert.equal(mod.sessions.get().nextCursor, 'cursor-2');
  assert.equal(mod.sessions.get().items.length, 2);
  assert.equal(mod.sessions.get().status, 'ready');
  assert.equal(mod.sessions.get().pageError.code, 'network');
});

test('saved older session is fetched independently of the first page', async (t) => {
  const mod = await setup(t, 'older');
  api.sessions.list = async () => page([row('new')], 'more');
  api.sessions.get = async (id) => { assert.equal(id, 'older'); return { session: row(id) }; };
  await mod.loadSessions();
  assert.equal(mod.sessions.get().activeId, 'older');
  assert.equal(mod.findSession('older').id, 'older');
  await mod.loadSessions();
  assert.equal(mod.activeSession().id, 'older');
});

test('detail fetch distinguishes not found from transient failure and can retry', async (t) => {
  const mod = await setup(t);
  api.sessions.get = async () => { throw new ApiError({ status: 404, code: 'session_not_found' }); };
  await mod.ensureSession('missing');
  assert.equal(mod.sessions.get().details.missing.status, 'missing');
  api.sessions.get = async () => { throw new ApiError({ status: 503, code: 'http_503' }); };
  await mod.ensureSession('older');
  assert.equal(mod.sessions.get().details.older.status, 'error');
  api.sessions.get = async () => ({ session: row('older') });
  await mod.ensureSession('older', { retry: true });
  assert.equal(mod.findSession('older').id, 'older');
});

test('out-of-order creates preserve both records and the latest requested selection', async (t) => {
  const mod = await setup(t);
  const a = deferred(), b = deferred();
  api.sessions.create = ({ title }) => title === 'a' ? a.promise : b.promise;
  const first = mod.createSession({ title: 'a' });
  const second = mod.createSession({ title: 'b' });
  b.resolve({ ...page([row('b'), row('old')]), session: row('b') });
  await second;
  a.resolve({ ...page([row('a'), row('old')]), session: row('a') });
  await first;
  assert.equal(mod.sessions.get().activeId, 'b');
  assert.ok(mod.findSession('a'));
  assert.ok(mod.findSession('b'));
});
