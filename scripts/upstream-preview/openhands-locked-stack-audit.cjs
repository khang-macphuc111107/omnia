const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const canvas = path.join(root, 'upstream_extractions/harnesses/openhands');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-openhands-stack-'));
  const key = crypto.randomBytes(32).toString('hex');
  const redact = s => String(s).replaceAll(key, '[REDACTED]');
  const uvDir = path.join(root, 'upstream_extractions/desktop-apps/cherry-studio/resources/binaries/win32-x64');
  const readyFile = path.join(scratch, 'ready.json');
  for (const dir of ['AppData/Roaming', 'AppData/Local', 'Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos', 'workspace'])
    fs.mkdirSync(path.join(scratch, dir), { recursive: true });
  const ports = [];
  while (ports.length < 5) {
    const p = await new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    if (!ports.includes(p)) ports.push(p);
  }
  const env = { ...process.env, PATH: uvDir + path.delimiter + process.env.PATH,
    USERPROFILE: scratch, HOME: scratch, APPDATA: path.join(scratch, 'AppData/Roaming'), LOCALAPPDATA: path.join(scratch, 'AppData/Local'),
    XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_DATA_HOME: path.join(scratch, 'data'), XDG_CACHE_HOME: path.join(scratch, 'cache'), XDG_STATE_HOME: path.join(scratch, 'state'),
    OMNIA_OPENHANDS_CANVAS: canvas, OMNIA_OPENHANDS_STACK_READY: readyFile,
    OH_AGENT_SERVER_LOCAL_PATH: path.join(root, 'upstream_extractions/harnesses/openhands-agent-sdk'),
    OH_AUTOMATION_LOCAL_PATH: path.join(root, 'upstream_extractions/harnesses/openhands-automation'),
    UV_NO_SYNC: '1', UV_FROZEN: '1', UV_PYTHON: '3.13', UV_CACHE_DIR: path.join(root, '.toolchains/openhands-uv-cache'),
    UV_PYTHON_INSTALL_DIR: path.join(root, '.toolchains/openhands-python'),
    OH_CANVAS_SAFE_STATE_DIR: path.join(scratch, 'state/canvas'),
    OH_SECRET_KEY_PATH: path.join(scratch, 'secret-key'), OH_SESSION_API_KEY_PATH: path.join(scratch, 'session-key'),
    OH_CANVAS_SAFE_BACKEND_PORT: String(ports[1]), OH_CANVAS_SAFE_AUTOMATION_PORT: String(ports[2]),
    OH_CANVAS_SAFE_VSCODE_PORT: String(ports[3]), OH_CANVAS_SAFE_VITE_PORT: String(ports[4]),
    VITE_WORKING_DIR: path.join(scratch, 'workspace'), VITE_ENABLE_BROWSER_TOOLS: 'false',
    OH_ENABLE_BROWSER: 'false', OH_ENABLE_VSCODE: 'false', OH_WORKSPACE_PATH: path.join(scratch, 'workspace'),
    OH_CONVERSATION_WORKTREE_ROOT: path.join(scratch, 'worktrees'), OH_TELEMETRY_CONSENT: 'denied',
    AUTOMATION_STREAMS_ENABLED: 'false', DO_NOT_TRACK: '1', VITE_DO_NOT_TRACK: '1',
    LOCAL_BACKEND_API_KEY: key, OH_SECRET_KEY: key, AUTOMATION_KV_SECRET: key, PYTHONUTF8: '1' };
  for (const name of Object.keys(env)) if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY)$/.test(name) && !['LOCAL_BACKEND_API_KEY', 'OH_SECRET_KEY'].includes(name)) delete env[name];
  const child = spawn(process.execPath, [path.join(__dirname, 'openhands-locked-stack-entry.mjs'), '--port', String(ports[0])], {
    cwd: canvas, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; let closed = false; let exitCode = null; let error = null;
  child.stdout.on('data', s => { log += redact(s); }); child.stderr.on('data', s => { log += redact(s); });
  const done = new Promise(resolve => { child.on('error', e => { error = e.message; closed = true; resolve(); });
    child.on('close', code => { closed = true; exitCode = code; resolve(); }); });
  const observations = []; let readiness = null; const checks = {};
  const base = `http://127.0.0.1:${ports[0]}`;
  async function probe(route, authenticated = true, method = 'GET', body) {
    const response = await fetch(base + route, { method,
      headers: { ...(authenticated ? { 'X-Session-API-Key': key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    const raw = redact(await response.text()); let data; try { data = JSON.parse(raw); } catch { data = raw.slice(0, 1500); }
    const result = { route, authenticated, method, status: response.status, body: data }; observations.push(result); return result;
  }
  try {
    const deadline = Date.now() + 240000; let nextNotice = 0;
    while (!closed && !fs.existsSync(readyFile) && Date.now() < deadline) {
      if (Date.now() >= nextNotice) { console.log(`Upstream Canvas stack starting; PID ${child.pid}`); nextNotice = Date.now() + 30000; }
      await delay(500);
    }
    if (fs.existsSync(readyFile)) {
      readiness = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
      checks.agentReady = readiness.agentServerReady === true;
      checks.frontend = (await probe('/')).status === 200;
      const info = await probe('/server_info'); checks.serverVersion = info.status === 200 && info.body.version === '1.59.0';
      checks.agentAuth = (await probe('/api/conversations/search', false)).status === 401;
      checks.agentList = (await probe('/api/conversations/search')).status === 200;
      const autoDeadline = Date.now() + 60000;
      while (!closed && Date.now() < autoDeadline) {
        try { if ((await probe('/api/automation/health')).status === 200) { checks.automationHealthy = true; break; } } catch {}
        await delay(1000);
      }
      checks.automationAuth = (await probe('/api/automation/v1', false)).status === 401;
      checks.automationList = (await probe('/api/automation/v1')).status === 200;
      const execution = await probe('/api/bash/execute_bash_command', true, 'POST', { command: 'echo OMNIA_CANVAS_INGRESS_EXEC_OK', cwd: path.join(scratch, 'workspace'), timeout: 15 });
      checks.ingressExecution = execution.status === 200 && execution.body.exit_code === 0 && execution.body.stdout?.includes('OMNIA_CANVAS_INGRESS_EXEC_OK');
    }
  } catch (e) { error = redact(e.stack); }
  finally {
    const exitedBeforeCleanup = closed;
    const cleanup = !closed && child.pid ? spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' }) : null;
    await Promise.race([done, delay(10000)]);
    fs.writeFileSync(path.join(root, 'artifacts/upstream-ui/openhands-locked-stack.log'), log);
    const report = { generatedAt: new Date().toISOString(), scratch, base, readiness, checks, observations,
      process: { pid: child.pid, closed, exitCode, exitedBeforeCleanup, cleanupExitCode: cleanup?.status }, error,
      implementation: 'Official Canvas orchestration main() with supported startAgentServer embedding hook pointing to lockfile-installed local SDK venv. Automation uses official local-path uv run with UV_NO_SYNC=1 and UV_FROZEN=1.',
      limitations: ['Source development stack; not packaged desktop', 'No model/provider request', 'Full UI/IPC and behavioral parity unverified'] };
    fs.writeFileSync(path.join(root, 'artifacts/upstream-ui/openhands-locked-stack-audit.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (error || !readiness || Object.values(checks).some(x => x !== true)) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
