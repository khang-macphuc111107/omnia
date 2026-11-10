const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

// Exercise the packaged Agent Server's real run path against a local,
// deterministic OpenAI-compatible provider. No external model or credential.
(async () => {
  const root = path.resolve(__dirname, '../..');
  const artifacts = path.join(root, 'artifacts/upstream-ui');
  const packageRoot = path.join(os.tmpdir(), 'omnia-openhands-packaged-509babe7e2304fdbae3d4ab0796192c4');
  const exe = path.join(packageRoot, 'OpenHands Agent Canvas.exe');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-openhands-dispatch-'));
  const stateDir = path.join(scratch, 'state'); const home = path.join(scratch, 'home'); const userData = path.join(scratch, 'user-data');
  for (const p of ['AppData/Roaming', 'AppData/Local', 'Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos', 'workspace', 'config', 'data', 'cache', 'state']) fs.mkdirSync(path.join(home, p), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const key = crypto.randomBytes(32).toString('hex');
  const providerRequests = []; let provider;
  const checks = {}; const observations = [];
  provider = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => {
      let body = null; try { body = JSON.parse(raw); } catch {}
      providerRequests.push({ method: req.method, url: req.url, model: body?.model, messageCount: body?.messages?.length || 0, hasTools: Array.isArray(body?.tools) && body.tools.length > 0 });
      const payload = { id: 'chatcmpl-omnia-dispatch', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body?.model || 'omnia-test', choices: [{ index: 0, message: { role: 'assistant', content: 'OMNIA_PACKAGED_AGENT_DISPATCH_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload));
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerPort = provider.address().port;
  const env = { ...process.env, USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'), PORT: '18170', OH_CANVAS_SAFE_BACKEND_PORT: '18171', OH_CANVAS_SAFE_AUTOMATION_PORT: '18172', OH_CANVAS_SAFE_VITE_PORT: '18174', OH_CANVAS_SAFE_STATE_DIR: stateDir, LOCAL_BACKEND_API_KEY: key, OH_SECRET_KEY: key, OH_ENABLE_BROWSER: 'false', OH_ENABLE_VSCODE: 'false', DO_NOT_TRACK: '1', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' };
  for (const name of Object.keys(env)) if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY)$/.test(name) && !['LOCAL_BACKEND_API_KEY', 'OH_SECRET_KEY'].includes(name)) delete env[name];
  const headers = { 'X-Session-API-Key': key, Authorization: `Bearer ${key}` };
  const child = spawn(exe, ['--no-sandbox', '--disable-gpu', '--disable-updates', '--user-data-dir', userData], { cwd: packageRoot, env, windowsHide: true, stdio: ['ignore', fs.openSync(path.join(artifacts, 'openhands-packaged-agent-dispatch.log'), 'w'), fs.openSync(path.join(artifacts, 'openhands-packaged-agent-dispatch.err.log'), 'w')] });
  async function request(route, method = 'GET', body) { const r = await fetch(`http://127.0.0.1:18170${route}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) }); const text = await r.text(); let value; try { value = JSON.parse(text); } catch { value = text; } const o = { route, method, status: r.status, body: value }; observations.push(o); return o; }
  async function stop() { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); await delay(2500); const ps = `$s=${JSON.stringify(scratch)}; Get-CimInstance Win32_Process | ? { $_.CommandLine -and $_.CommandLine.Contains($s) } | % { taskkill /PID $_.ProcessId /T /F 2>$null|Out-Null }`; spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }); }
  let conversationId = null; let error = null;
  try {
    const deadline = Date.now() + 180000; while (Date.now() < deadline) { try { const r = await fetch('http://127.0.0.1:18170/server_info', { headers, signal: AbortSignal.timeout(3000) }); if (r.status === 200) { checks.packagedReady = true; break; } } catch {} await delay(1000); }
    const created = await request('/api/conversations', 'POST', { agent: { kind: 'Agent', llm: { model: 'openai/omnia-test', api_key: 'mock-key', base_url: `http://127.0.0.1:${providerPort}/v1` }, tools: [] }, workspace: { working_dir: path.join(scratch, 'workspace') }, initial_message: { role: 'user', content: [{ type: 'text', text: 'Return the provider marker and finish.' }], run: true } });
    conversationId = created.body?.id; checks.conversationCreatedAndStarted = created.status === 201 && typeof conversationId === 'string';
    if (conversationId) {
      const end = Date.now() + 90000; let final = null; while (Date.now() < end) { await delay(1500); const r = await request(`/api/conversations/${conversationId}`); final = r.body; if (r.status === 200 && ['finished', 'error', 'stuck'].includes(final?.execution_status)) break; }
      checks.executionFinished = final?.execution_status === 'finished';
      const response = await request(`/api/conversations/${conversationId}/agent_final_response`); checks.finalResponseContainsProviderMarker = response.status === 200 && JSON.stringify(response.body).includes('OMNIA_PACKAGED_AGENT_DISPATCH_OK');
    }
    checks.providerReceivedChatCompletion = providerRequests.length > 0 && providerRequests.some(r => r.url?.includes('/chat/completions'));
  } catch (e) { error = e.stack || String(e); }
  finally { await stop(); await new Promise(resolve => provider.close(resolve)); const report = { generatedAt: new Date().toISOString(), executable: exe, scratch, provider: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, requests: providerRequests }, observations, checks, error, isolation: { localProviderOnly: true, samePackagedExecutable: true, telemetryDisabled: true, noExternalModelRequest: true }, limitations: ['Mock provider proves dispatch plumbing and finalization only; real provider credentials/model behavior remain unverified', 'Installer and full visual UI/IPC parity remain unverified'] }; fs.writeFileSync(path.join(artifacts, 'openhands-packaged-agent-dispatch-audit.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); if (error || Object.values(checks).some(v => v !== true)) process.exitCode = 1; }
})().catch(e => { console.error(e); process.exitCode = 1; });
