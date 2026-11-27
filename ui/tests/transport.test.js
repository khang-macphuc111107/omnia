import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { request, api, ApiError, connection } from '../app/api.js';

async function serverFor(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('deadline includes the response body after immediate headers', async (t) => {
  const origin = await serverFor(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.flushHeaders();
    const timer = setTimeout(() => res.end('{"ok":true}'), 300);
    res.on('close', () => clearTimeout(timer));
  });
  await assert.rejects(request('GET', origin, { timeout: 60 }), (e) => e instanceof ApiError && e.code === 'timeout');
});

test('caller can cancel a response body without marking the connection offline', async (t) => {
  const abort = new AbortController();
  const origin = await serverFor(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.flushHeaders();
    const cancel = setTimeout(() => abort.abort(), 40);
    const finish = setTimeout(() => res.end('{"ok":true}'), 250);
    res.on('close', () => { clearTimeout(cancel); clearTimeout(finish); });
  });
  connection.set({ status: 'online', lastError: null });
  await assert.rejects(request('GET', origin, { timeout: 2000, signal: abort.signal }), (e) => e.code === 'aborted');
  assert.equal(connection.get().status, 'online');
});

test('truncated body produces a classified network error', async (t) => {
  const origin = await serverFor(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 100 });
    res.write('{');
    const timer = setTimeout(() => res.destroy(), 30);
    res.on('close', () => clearTimeout(timer));
  });
  await assert.rejects(request('GET', origin), (e) => e instanceof ApiError && e.code === 'network');
});

test('session adapter sends cursor/limit and escapes a detail ID', async (t) => {
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(url); return new Response('{"ok":true}'); };
  await api.sessions.list({ limit: 7, cursor: 'opaque.cursor' });
  await api.sessions.get('a/b c');
  assert.deepEqual(urls, ['/api/sessions?limit=7&cursor=opaque.cursor', '/api/sessions/a%2Fb%20c']);
});

test('HTTP and invalid JSON errors retain their original classification', async (t) => {
  const origin = await serverFor(t, (req, res) => {
    if (req.url === '/error') res.writeHead(503).end('{"error":"unavailable"}');
    else res.end('invalid');
  });
  await assert.rejects(request('GET', `${origin}/error`), (e) => e.code === 'unavailable' && e.status === 503);
  await assert.rejects(request('GET', `${origin}/invalid`), (e) => e.code === 'invalid_response');
});
