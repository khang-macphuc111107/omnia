const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

// Exercise official local services without creating or dispatching model work.
(async () => {
  const root = path.resolve(__dirname, '../..');
  const artifacts = path.join(root, 'artifacts/upstream-ui');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-openhands-backend-'));
  const key = crypto.randomBytes(32).toString('hex');
  const redact = s => String(s).replaceAll(key, '[REDACTED]');
  const services = [];
  const observations = [];
  const checks = {};
  const port = () => new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); });
  });
  for (const dir of ['AppData/Roaming', 'AppData/Local', 'Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos', 'workspace', 'state'])
    fs.mkdirSync(path.join(scratch, dir), { recursive: true });
  const env = { ...process.env, USERPROFILE: scratch, HOME: scratch,
    APPDATA: path.join(scratch, 'AppData/Roaming'), LOCALAPPDATA: path.join(scratch, 'AppData/Local'),
    XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_DATA_HOME: path.join(scratch, 'data'),
    XDG_CACHE_HOME: path.join(scratch, 'cache'), XDG_STATE_HOME: path.join(scratch, 'state'),
    PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', DO_NOT_TRACK: '1',
    OH_SESSION_API_KEYS_0: key, OH_SECRET_KEY: key, OH_ENABLE_BROWSER: 'false', OH_ENABLE_VSCODE: 'false',
    OH_TELEMETRY_CONSENT: 'denied', OH_PERSISTENCE_DIR: path.join(scratch, 'state'),
    OH_CONVERSATIONS_PATH: path.join(scratch, 'conversations'), OH_WORKSPACE_PATH: path.join(scratch, 'workspace'),
    OH_CONVERSATION_WORKTREE_ROOT: path.join(scratch, 'worktrees'), OH_BASH_EVENTS_DIR: path.join(scratch, 'bash-events') };
  // Do not inherit credentials from the shell into an isolated service probe.
  for (const name of Object.keys(env))
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY)$/.test(name) && !['OH_SECRET_KEY'].includes(name)) delete env[name];
  function launch(name, module, args, extraEnv = {}) {
    const source = path.join(root, 'upstream_extractions/harnesses', module);
    const executable = path.join(source, '.venv/Scripts/python.exe');
    const service = { name, source, executable, args, log: '', closed: false, exitCode: null, spawnError: null };
    service.child = spawn(executable, args, { cwd: scratch, env: { ...env, ...extraEnv }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    service.child.stdout.on('data', data => { service.log += redact(data); });
    service.child.stderr.on('data', data => { service.log += redact(data); });
    service.done = new Promise(resolve => {
      service.child.on('error', e => { service.spawnError = e.message; service.closed = true; resolve(); });
      service.child.on('close', code => { service.exitCode = code; service.closed = true; resolve(); });
    });
    services.push(service); return service;
  }
  async function probe(base, route, authenticated = true, method = 'GET', body) {
    const response = await fetch(base + route, { method,
      headers: { ...(authenticated ? { 'X-Session-API-Key': key, Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const raw = redact(await response.text());
    let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    const observation = { base, route, method, authenticated, status: response.status, body: parsed };
    observations.push(observation); return observation;
  }
  async function ready(service, base, route) {
    const deadline = Date.now() + 180000;
    let nextNotice = Date.now();
    while (!service.closed && Date.now() < deadline) {
      try { const r = await probe(base, route); if (r.status === 200) return true; }
      catch (e) { service.lastConnectionError = e.message; }
      if (Date.now() >= nextNotice) { console.log(`${service.name}: waiting for ${route}; PID ${service.child.pid}`); nextNotice = Date.now() + 30000; }
      await delay(1000);
    }
    return false;
  }
  async function stop(service) {
    service.exitedBeforeCleanup = service.closed;
    if (!service.closed && service.child.pid) {
      const killed = spawnSync('taskkill', ['/PID', String(service.child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
      service.cleanupExitCode = killed.status;
    }
    await Promise.race([service.done, delay(10000)]);
  }
  let error = null;
  try {
    const agentPort = await port(); const autoPort = await port();
    const base = `http://127.0.0.1:${agentPort}`;
    const agent = launch('agent-server', 'openhands-agent-sdk', ['-m', 'openhands.agent_server', '--host', '127.0.0.1', '--port', String(agentPort)]);
    agent.base = base;
    agent.ready = await ready(agent, base, '/server_info');
    if (agent.ready) {
      await probe(base, '/server_info', false);
      checks.agentAuthentication = (await probe(base, '/api/conversations/search', false)).status === 401;
      await probe(base, '/api/conversations/search');
      const echo = await probe(base, '/api/bash/execute_bash_command', true, 'POST', { command: 'echo OMNIA_OPENHANDS_LOCAL_EXEC_OK', cwd: path.join(scratch, 'workspace'), timeout: 15 });
      checks.localExecution = echo.status === 200 && echo.body.exit_code === 0 && echo.body.stdout?.includes('OMNIA_OPENHANDS_LOCAL_EXEC_OK');
      const exit7 = await probe(base, '/api/bash/execute_bash_command', true, 'POST', { command: 'cmd /c exit 7', cwd: path.join(scratch, 'workspace'), timeout: 15 });
      checks.exitPropagation = exit7.status === 200 && exit7.body.exit_code === 7;
      await probe(base, '/api/bash/bash_events/search');
    }
    const automation = launch('automation', 'openhands-automation', ['-m', 'uvicorn', 'openhands.automation.app:app', '--host', '127.0.0.1', '--port', String(autoPort)], {
      AUTOMATION_AGENT_SERVER_URL: base, AUTOMATION_AGENT_SERVER_API_KEY: key, AUTOMATION_LOCAL_API_KEY: key,
      AUTOMATION_KV_SECRET: key, AUTOMATION_STREAMS_ENABLED: 'false', AUTOMATION_POSTHOG_API_KEY: '',
      AUTOMATION_WORKSPACE_BASE: path.join(scratch, 'automation-workspace'),
      AUTOMATION_DB_URL: `sqlite+aiosqlite:///${path.join(scratch, 'automations.db').replaceAll('\\', '/')}`,
      AUTOMATION_BASE_URL: `http://127.0.0.1:${autoPort}` });
    automation.base = `http://127.0.0.1:${autoPort}`;
    automation.ready = await ready(automation, automation.base, '/api/automation/health');
    if (automation.ready) {
      checks.automationAuthentication = (await probe(automation.base, '/api/automation/v1', false)).status === 401;
      checks.automationList = (await probe(automation.base, '/api/automation/v1')).status === 200;
      const draft = await probe(automation.base, '/api/automation/v1/drafts', true, 'POST', { endpoint: '/v1', name: 'Omnia isolated persistence audit', draft: {} });
      checks.draftCreated = draft.status === 201 && typeof draft.body.id === 'string' && draft.body.dispatchable === false;
      if (checks.draftCreated) {
        const route = `/api/automation/v1/drafts/${draft.body.id}`;
        checks.draftUpdated = (await probe(automation.base, route, true, 'PATCH', { name: 'Omnia audit renamed' })).status === 200;
        await stop(automation);
        const restarted = launch('automation-restarted', 'openhands-automation', automation.args, {
          AUTOMATION_AGENT_SERVER_URL: base, AUTOMATION_AGENT_SERVER_API_KEY: key, AUTOMATION_LOCAL_API_KEY: key,
          AUTOMATION_KV_SECRET: key, AUTOMATION_STREAMS_ENABLED: 'false', AUTOMATION_POSTHOG_API_KEY: '',
          AUTOMATION_WORKSPACE_BASE: path.join(scratch, 'automation-workspace'),
          AUTOMATION_DB_URL: `sqlite+aiosqlite:///${path.join(scratch, 'automations.db').replaceAll('\\', '/')}`,
          AUTOMATION_BASE_URL: automation.base });
        restarted.base = automation.base;
        restarted.ready = await ready(restarted, restarted.base, '/api/automation/health');
        if (restarted.ready) {
          const persisted = await probe(restarted.base, route);
          checks.draftPersistedAfterRestart = persisted.status === 200 && persisted.body.id === draft.body.id && persisted.body.name === 'Omnia audit renamed';
          checks.draftDeleted = (await probe(restarted.base, route, true, 'DELETE')).status === 204;
          checks.deletedDraftMissing = (await probe(restarted.base, route)).status === 404;
        }
      }
      const schema = await probe(automation.base, '/api/automation/openapi.json');
      if (schema.status === 200) {
        fs.writeFileSync(path.join(artifacts, 'openhands-automation-openapi.json'), JSON.stringify(schema.body, null, 2) + '\n');
        schema.body = { info: schema.body.info, paths: Object.keys(schema.body.paths || {}) };
      }
    }
  } catch (e) { error = redact(e.stack); }
  finally {
    for (const service of services.reverse()) {
      if (service.cleanupExitCode === undefined) await stop(service);
      fs.writeFileSync(path.join(artifacts, `openhands-${service.name}-native.log`), service.log);
    }
    const report = { generatedAt: new Date().toISOString(), scratch,
      services: services.map(s => ({ name: s.name, source: path.relative(root, s.source),
        revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: s.source, encoding: 'utf8' }).stdout?.trim(),
        executable: path.relative(root, s.executable), args: s.args, base: s.base,
        pid: s.child.pid, ready: s.ready, closed: s.closed, exitCode: s.exitCode,
        exitedBeforeCleanup: s.exitedBeforeCleanup, cleanupExitCode: s.cleanupExitCode,
        spawnError: s.spawnError, lastConnectionError: s.lastConnectionError })), observations, checks, error,
      isolation: { scratchHome: true, scratchDatabase: true, telemetryDisabled: true, loopbackOnly: true, browserDisabled: true, vscodeDisabled: true },
      limitations: ['No model or provider requests', 'No automation dispatch', 'No desktop UI evidence in this probe', 'Full behavioral parity unverified'] };
    fs.writeFileSync(path.join(artifacts, 'openhands-backend-runtime-audit.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report, observations: observations.map(p => ({ route: p.route, status: p.status, authenticated: p.authenticated, body: JSON.stringify(p.body).slice(0, 2000) })) }, null, 2));
    if (error || services.some(s => !s.ready) || Object.values(checks).some(passed => passed !== true)) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
