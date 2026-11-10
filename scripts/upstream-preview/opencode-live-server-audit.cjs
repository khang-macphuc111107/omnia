const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

(async () => {
  const workspace = path.resolve(__dirname, '../..');
  const root = path.join(workspace, 'upstream_extractions/harnesses/opencode');
  const bun = process.env.OMNIA_BUN || path.join(workspace, '.toolchains/bun-1.4.4/package/bin/bun.exe');
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-opencode-live-'));
  const password = crypto.randomBytes(32).toString('hex');
  const authorization = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
  const sanitize = (s) => s.replaceAll(password, '[REDACTED]').replaceAll(authorization, '[REDACTED]');
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  const env = { ...process.env, PATH: path.dirname(bun) + path.delimiter + process.env.PATH,
    XDG_DATA_HOME: path.join(isolated, 'data'), XDG_CACHE_HOME: path.join(isolated, 'cache'),
    XDG_CONFIG_HOME: path.join(isolated, 'config'), XDG_STATE_HOME: path.join(isolated, 'state'),
    OPENCODE_TEST_HOME: isolated, OPENCODE_CONFIG_DIR: path.join(isolated, 'config'),
    OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1' };
  const args = ['run', 'src/index.ts', 'serve', '--hostname', '127.0.0.1', '--port', String(port)];
  let output = ''; let terminal = false; let exitCode = null; let signal = null; let spawnError = null;
  const child = spawn(bun, args, { cwd: path.join(root, 'packages/cli'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (s) => { output += s; }); child.stderr.on('data', (s) => { output += s; });
  const closed = new Promise((resolve) => {
    child.on('error', (error) => { spawnError = error.message; terminal = true; resolve(); });
    child.on('close', (code, sig) => { exitCode = code; signal = sig; terminal = true; resolve(); });
  });
  const base = `http://127.0.0.1:${port}`;
  const probes = []; let lastConnectionError = null; let sessionLifecycle = null; let probeError = null;
  const probe = async (route, auth, method = 'GET', payload) => {
    const response = await fetch(base + route, { method, headers: { ...(auth ? { Authorization: authorization } : {}), ...(payload ? { 'Content-Type': 'application/json' } : {}) }, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(15000) });
    const body = await response.text();
    return { route, method, authenticated: auth, status: response.status, contentType: response.headers.get('content-type'), body: sanitize(body).slice(0, 5000) };
  };
  try {
    const deadline = Date.now() + 60000;
    while (!terminal && Date.now() < deadline) {
      try { probes.push(await probe('/api/info', true)); break; }
      catch (error) { lastConnectionError = error.message; await delay(500); }
    }
    if (probes.length) {
      probes.push(await probe('/api/info', false));
      probes.push(await probe('/', false));
      const created = await probe('/api/session', true, 'POST', { title: 'Omnia isolated lifecycle audit', location: { directory: isolated } });
      probes.push(created);
      let session = null;
      try { session = JSON.parse(created.body).data; } catch {}
      if (created.status === 200 && typeof session?.id === 'string') {
        const route = `/api/session/${encodeURIComponent(session.id)}`;
        const read = await probe(route, true); probes.push(read);
        const changed = await probe(route, true, 'PATCH', { title: 'Omnia audit renamed' }); probes.push(changed);
        const renamed = await probe(route, true); probes.push(renamed);
        const removed = await probe(route, true, 'DELETE'); probes.push(removed);
        const missing = await probe(route, true); probes.push(missing);
        const data = (p) => { try { return JSON.parse(p.body).data; } catch { return null; } };
        sessionLifecycle = { id: session.id, createdWithRequestedTitle: session.title === 'Omnia isolated lifecycle audit', readMatchesID: data(read)?.id === session.id,
          renamePersisted: data(renamed)?.id === session.id && data(renamed)?.title === 'Omnia audit renamed', deleteReturnedNoContent: removed.status === 204, deletedSessionReturns404: missing.status === 404 };
      }
    }
  } catch (error) {
    probeError = sanitize(error.message);
  } finally {
    const exitedBeforeCleanup = terminal;
    const cleanup = !terminal && child.pid ? spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true }) : null;
    await Promise.race([closed, delay(5000)]);
    const log = path.join(workspace, 'artifacts/upstream-ui/opencode-live-server.log');
    fs.writeFileSync(log, sanitize(output));
    const info = probes.find((p) => p.route === '/api/info' && p.authenticated);
    let identity = null;
    try { identity = info ? JSON.parse(info.body) : null; } catch {}
    const report = { generatedAt: new Date().toISOString(), provenance: { repository: 'https://github.com/anomalyco/opencode', revision: (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout || '').trim(), bunSha256: crypto.createHash('sha256').update(fs.readFileSync(bun)).digest('hex') }, command: { executable: path.relative(workspace, bun), args, cwd: 'upstream_extractions/harnesses/opencode/packages/cli' },
      isolation: { directory: isolated, binding: base, modelFetchDisabled: true, projectConfigDisabled: true, simulatedProvider: false, upstreamSharedTmp: path.join(os.tmpdir(), 'opencode') },
      process: { pid: child.pid, terminal, exitedBeforeCleanup, exitCode, signal, spawnError, cleanupExitCode: cleanup?.status ?? null },
      probes, lastConnectionError, probeError, sessionLifecycle,
      serverIdentityConfirmed: info?.status === 200 && typeof identity?.version === 'string' && identity?.pid === child.pid,
      unauthorizedRequestRejected: probes.some((p) => p.route === '/api/info' && !p.authenticated && p.status === 401),
      log: { path: 'artifacts/upstream-ui/opencode-live-server.log', sha256: crypto.createHash('sha256').update(fs.readFileSync(log)).digest('hex') },
      runtimeParity: 'unverified', conclusion: 'Isolated upstream server identity, authorization and local session lifecycle probes only. Individual observations are recorded without inferring provider execution, tools, desktop UI or full behavioral parity.' };
    fs.writeFileSync(path.join(workspace, 'artifacts/upstream-ui/opencode-live-server-audit.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
