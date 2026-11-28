import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { request, api, ApiError, connection, checkHealth } from '../app/api.js';

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

test('Rust omnia-studio payload shapes normalize cleanly across sessions, templates, graph, memory, router and rag', async (t) => {
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url.startsWith('/api/sessions')) {
      return new Response(JSON.stringify({ ok: true, sessions: [{ id: 's1', title: 'Rust', model_id: 'm1', createdAtMs: 10, updatedAtMs: 20 }] }));
    }
    if (url === '/api/composer/templates') {
      return new Response(JSON.stringify({ ok: true, templates: [{ id: 'math-fraction', category: 'Math', label: 'Fraction', latex_snippet: '\\frac{a}{b}', unicode_preview: 'a/b' }] }));
    }
    if (url === '/api/graph') {
      return new Response(JSON.stringify({
        ok: true,
        nodes: [{ id: 'coordinator', role: 'coordinator', active: true, owned_paths: ['ui/**'], last_read_seq: 4 }],
        links: [{ from_id: 'coordinator', to_id: 'verifier', bidirectional: true }],
        messages: [{ seq: 1, from_id: 'coordinator', recipients: ['verifier'], payload: 'ping', sent_at_ms: 99, hop_count: 1, max_hops: 4 }],
        graphifyNodes: [{ id: 'n1', kind: 'CodeModule', label: 'api', source_path: 'ui/app/api.js' }],
        graphifyEdges: [{ from_id: 'n1', to_id: 'n2', relation: 'imports', provenance: 'EXTRACTED', confidence_bps: 10000, source_locator: 'ui/app/api.js:1' }]
      }));
    }
    if (url === '/api/memory') {
      return new Response(JSON.stringify({
        ok: true,
        entries: [{ id: 'a/b', namespace: 'a', key: 'b', content: 'ok', tier: 'Durable', updatedAtMs: 500 }],
        erasures: [{ receiptId: 'er-1', namespace: 'a', key: 'old', previousDigestSha256: 'abc', erasedAtMs: 600, verifiedPlaintextFree: true }]
      }));
    }
    if (url === '/api/rag/plan') {
      return new Response(JSON.stringify({
        ok: true, query: 'q', language: 'en', uncertaintyScore: 0.4, shouldRetrieve: true, triggers: ['direct_requirement_lookup'],
        subQueries: [{ sub_query_id: 'sq1', text: 'lookup', intent: 'direct_requirement_lookup' }],
        citedSources: [{ source_id: 'ws:README.md', title: 'README', locator: 'README.md', excerpt: 'Rust', relevance_bps: 8500, provenance: 'EXTRACTED' }],
        unusedSources: [{ source_id: 'ws:old', locator: 'old.md', exclusion_reason: 'below_relevance_threshold' }]
      }));
    }
    return new Response(JSON.stringify({ ok: true }));
  };

  const sess = await api.sessions.list({ limit: 10, cursor: { updatedAtMs: 123, id: 's0' } });
  assert.equal(calls[0].url, '/api/sessions?limit=10&cursorUpdatedAtMs=123&cursorId=s0');
  assert.equal(sess.sessions[0].updatedAt, 20);
  assert.equal(sess.sessions[0].modelId, 'm1');

  const tpls = await api.composer.templates();
  assert.equal(tpls.templates[0].category, 'Mathematics');
  assert.equal(tpls.templates[0].title, 'Fraction');
  assert.equal(tpls.templates[0].latex, '\\frac{a}{b}');

  const g = await api.graph.get();
  assert.equal(g.nodes[0].state, 'ACTIVE');
  assert.deepEqual(g.nodes[0].disjointPaths, ['ui/**']);
  assert.equal(g.links[0].mode, 'Duplex');
  assert.equal(g.messages[0].from, 'coordinator');
  assert.equal(g.messages[0].text, 'ping');
  assert.equal(g.graphifyNodes[0].path, 'ui/app/api.js');

  const mem = await api.memory.list();
  assert.equal(mem.entries[0].updatedAt, 500);
  assert.equal(mem.erasures[0].erasedId, 'a/old');
  assert.equal(mem.erasures[0].erasedAt, 600);

  const rag = await api.rag.plan({ query: 'q' });
  assert.equal(rag.subQueries[0].angle, 'direct_requirement_lookup');
  assert.equal(rag.subQueries[0].query, 'lookup');
  assert.equal(rag.citedSources[0].id, 'ws:README.md');
  assert.equal(rag.citedSources[0].score, 0.85);
  assert.equal(rag.unusedSources[0].reason, 'below_relevance_threshold');
});

test('AUD-24 & AUD-25: capabilities, chat.stop and router.cancel adapters work and normalize cleanly', async (t) => {
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ method: init?.method || 'GET', url, body: init?.body ? JSON.parse(init.body) : null });
    if (url === '/api/capabilities') {
      return new Response(JSON.stringify({
        ok: true,
        schema: 'omnia.capabilities.v1',
        capabilities: [
          { id: 'health', enabled: true, endpoint: '/api/health' },
          { id: 'runtime_proxy', enabled: false, timeoutMs: 3000 }
        ]
      }));
    }
    return new Response(JSON.stringify({ ok: true }));
  };

  const caps = await api.capabilities();
  assert.equal(caps.schema, 'omnia.capabilities.v1');
  assert.equal(caps.capabilities.length, 2);
  assert.equal(caps.capabilities[0].status, 'ready');
  assert.equal(caps.capabilities[1].status, 'unavailable');
  assert.equal(caps.capabilities[1].detail, '3000ms');

  await api.chat.stop({ sessionId: 's1', messageId: 'm1' });
  await api.router.cancel({ sessionId: 's1', idempotencyKey: 'chat:s1:m1' });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    'GET /api/capabilities',
    'POST /api/chat/stop',
    'POST /api/router/cancel'
  ]);
});

test('AUD-25: checkHealth separates HTTP 5xx and invalid JSON service failures from transport reachability and recovers', async (t) => {
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  let mode = '503';
  globalThis.fetch = async () => {
    if (mode === '503') return new Response('{"error":"internal_error"}', { status: 503 });
    if (mode === 'invalid') return new Response('not-json', { status: 200 });
    return new Response(JSON.stringify({ ok: true, engine: 'Omnia Full Native Rust', pid: 42 }), { status: 200 });
  };

  await checkHealth();
  assert.equal(connection.get().status, 'online');
  assert.equal(connection.get().serviceHealth, 'unhealthy');

  mode = 'invalid';
  await checkHealth();
  assert.equal(connection.get().status, 'online');
  assert.equal(connection.get().serviceHealth, 'unhealthy');

  mode = 'ok';
  await checkHealth();
  assert.equal(connection.get().status, 'online');
  assert.equal(connection.get().serviceHealth, 'healthy');
  assert.equal(connection.get().lastError, null);
  assert.equal(connection.get().health.pid, 42);
});
