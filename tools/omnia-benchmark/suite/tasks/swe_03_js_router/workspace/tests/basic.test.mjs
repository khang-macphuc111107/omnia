import assert from 'node:assert/strict';
import { Router } from '../src/router.mjs';

async function runBasicTests() {
  // 1. Static, param, and wildcard routes without colliding prefixes
  {
    const router = new Router();
    router.get('/health', (_req, res) => res.json({ ok: true }));
    router.get('/users/:id/profile', (req, res) =>
      res.json({ userId: req.params.id, tab: req.query.tab || 'overview' })
    );
    router.get('/assets/*filepath', (req, res) =>
      res.json({ file: req.params.filepath })
    );

    const r1 = await router.handle({ method: 'GET', url: '/health' });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.body, { ok: true });

    const r2 = await router.handle({
      method: 'GET',
      url: '/users/alice%20smith/profile?tab=security',
    });
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.body, { userId: 'alice smith', tab: 'security' });

    const r3 = await router.handle({
      method: 'GET',
      url: '/assets/img/logo/icon.png',
    });
    assert.equal(r3.status, 200);
    assert.deepEqual(r3.body, { file: 'img/logo/icon.png' });

    const r4 = await router.handle({ method: 'GET', url: '/does-not-exist' });
    assert.equal(r4.status, 404);
  }

  // 2. Normal middleware ordering + sync error caught by error middleware
  {
    const router = new Router();
    const trace = [];
    router.use((req, _res, next) => {
      trace.push('mw1');
      req.tag = 'verified';
      next();
    });
    router.get('/ok', (req, res) => {
      trace.push('handler');
      res.status(201).json({ tag: req.tag });
    });
    router.get('/sync-boom', () => {
      throw new Error('sync failure');
    });
    router.use((err, _req, res, _next) => {
      res.status(422).json({ handled: err.message });
    });

    const okRes = await router.handle({ method: 'GET', url: '/ok' });
    assert.equal(okRes.status, 201);
    assert.deepEqual(okRes.body, { tag: 'verified' });
    assert.deepEqual(trace, ['mw1', 'handler']);

    const errRes = await router.handle({ method: 'GET', url: '/sync-boom' });
    assert.equal(errRes.status, 422);
    assert.deepEqual(errRes.body, { handled: 'sync failure' });
  }

  // 3. Explicit next(err) reaches single error handler
  {
    const router = new Router();
    router.get('/next-err', (_req, _res, next) => {
      next(new Error('via next'));
    });
    router.use((err, _req, res, _next) => {
      res.status(400).json({ msg: err.message });
    });
    const res = await router.handle({ method: 'GET', url: '/next-err' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { msg: 'via next' });
  }

  console.log('All basic router tests passed.');
}

runBasicTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
