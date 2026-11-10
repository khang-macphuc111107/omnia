const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

// Verify that the packaged desktop stack keeps a real Agent Server conversation
// in the same state directory after the Electron process is restarted.
(async () => {
  const root = path.resolve(__dirname, '../..');
  const artifacts = path.join(root, 'artifacts/upstream-ui');
  const packageRoot = path.join(os.tmpdir(), 'omnia-openhands-packaged-509babe7e2304fdbae3d4ab0796192c4');
  const exe = path.join(packageRoot, 'OpenHands Agent Canvas.exe');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-openhands-packaged-persistence-'));
  const stateDir = path.join(scratch, 'state');
  const userData = path.join(scratch, 'user-data');
  const home = path.join(scratch, 'home');
  const key = crypto.randomBytes(32).toString('hex');
  const port = 18160;
  const agentPort = 18161;
  const automationPort = 18162;
  const frontendPort = 18164;
  for (const p of ['AppData/Roaming', 'AppData/Local', 'Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos', 'workspace', 'config', 'data', 'cache', 'state', 'user-data'])
    fs.mkdirSync(path.join(home, p), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const env = {
    ...process.env,
    USERPROFILE: home, HOME: home,
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
    PORT: String(port), AGENT_SERVER_PORT: String(agentPort), AUTOMATION_PORT: String(automationPort),
    FRONTEND_PORT: String(frontendPort), OH_CANVAS_SAFE_STATE_DIR: stateDir,
    LOCAL_BACKEND_API_KEY: key, OH_SESSION_API_KEYS_0: key, OH_SECRET_KEY: key, OH_ENABLE_BROWSER: 'false', OH_ENABLE_VSCODE: 'false',
    OH_TELEMETRY_CONSENT: 'denied', DO_NOT_TRACK: '1', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1', ELECTRON_ENABLE_LOGGING: '1'
  };
  for (const name of Object.keys(env)) if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY)$/.test(name) && !['OH_SECRET_KEY', 'LOCAL_BACKEND_API_KEY'].includes(name)) delete env[name];
  const launches = [];
  const observations = [];
  const checks = {};
  const headers = { 'X-Session-API-Key': key, Authorization: `Bearer ${key}` };
  async function request(route, method = 'GET', body) {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const text = await r.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
    const item = { route, method, status: r.status, body: value }; observations.push(item); return item;
  }
  async function launch(label) {
    const log = path.join(artifacts, `openhands-packaged-persistence-${label}.log`);
    const err = path.join(artifacts, `openhands-packaged-persistence-${label}.err.log`);
    const out = fs.openSync(log, 'w'); const error = fs.openSync(err, 'w');
    const child = spawn(exe, ['--no-sandbox', '--disable-gpu', '--disable-updates', '--user-data-dir', userData], { cwd: packageRoot, env, windowsHide: true, stdio: ['ignore', out, error] });
    const item = { label, pid: child.pid, log, err, child, exitCode: null };
    child.on('close', code => { item.exitCode = code; }); launches.push(item);
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      try { const r = await fetch(`http://127.0.0.1:${port}/server_info`, { headers, signal: AbortSignal.timeout(3000) }); if (r.status === 200) { item.ready = true; return item; } } catch {}
      await delay(1000);
    }
    item.ready = false; return item;
  }
  async function stop(item) {
    if (!item || !item.pid) return;
    spawnSync('taskkill', ['/PID', String(item.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    await delay(3000);
    // Electron can detach uvx children before its own process exits; clean only
    // this probe's exact scratch tree and leave user processes untouched.
    const ps = `$s=${JSON.stringify(scratch)}; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($s) } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }`;
    spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, encoding: 'utf8' });
  }
  let error = null; let conversationId = null;
  try {
    checks.packagedExecutable = fs.existsSync(exe);
    const first = await launch('first'); checks.firstLaunchReady = first.ready === true;
    if (first.ready) {
      const info = await request('/server_info'); checks.agentServerReady = info.status === 200;
      const created = await request('/api/conversations', 'POST', { agent: { kind: 'Agent', llm: { model: 'openai/gpt-4o-mini', api_key: key }, tools: [] }, workspace: { working_dir: path.join(scratch, 'workspace') }, initial_message: { role: 'user', content: [{ type: 'text', text: 'OMNIA persistence probe; do not run.' }], run: false } });
      conversationId = created.body?.id; checks.conversationCreated = created.status === 201 && typeof conversationId === 'string';
      if (conversationId) {
        const got = await request(`/api/conversations/${conversationId}`); checks.conversationReadableBeforeRestart = got.status === 200 && got.body?.id === conversationId;
      }
    }
    await stop(first);
    const second = await launch('second'); checks.secondLaunchReady = second.ready === true;
    if (second.ready && conversationId) {
      const restored = await request(`/api/conversations/${conversationId}`); checks.conversationRestoredAfterRestart = restored.status === 200 && restored.body?.id === conversationId;
      const search = await request('/api/conversations/search'); checks.searchContainsRestoredConversation = search.status === 200 && JSON.stringify(search.body).includes(conversationId);
    }
  } catch (e) { error = e.stack || String(e); }
  finally {
    for (const item of launches.reverse()) await stop(item);
    const files = [];
    function walk(dir) { if (!fs.existsSync(dir)) return; for (const name of fs.readdirSync(dir)) { const p = path.join(dir, name); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else files.push({ path: path.relative(scratch, p), bytes: st.size }); } }
    walk(scratch);
    const report = { generatedAt: new Date().toISOString(), packageRoot, executable: exe, scratch, stateDir, userData, ports: { ingress: port, agent: agentPort, automation: automationPort, frontend: frontendPort }, launches: launches.map(x => ({ label: x.label, pid: x.pid, ready: x.ready, exitCode: x.exitCode })), observations, checks, error, persistedStateFiles: files.filter(x => /state|user-data/i.test(x.path)), isolation: { scratchHome: true, sameStateAcrossRestarts: true, loopbackOnly: true, telemetryDisabled: true, noModelDispatch: true }, limitations: ['No provider/model request was dispatched', 'Installer was not executed', 'Full visual UI and IPC parity remain unverified'] };
    fs.writeFileSync(path.join(artifacts, 'openhands-packaged-persistence-audit.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (error || Object.values(checks).some(v => v !== true && typeof v === 'boolean')) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
