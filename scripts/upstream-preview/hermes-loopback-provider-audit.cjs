const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const target = path.resolve(__dirname, '../../upstream_extractions/harnesses/hermes-agent');
const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'omnia-hermes-loopback-'));
const pmRoot = process.env.OMNIA_HERMES_PM_ROOT;
const wrapper = process.env.OMNIA_HERMES_WRAPPER ? path.resolve(process.env.OMNIA_HERMES_WRAPPER) : null;
const activation = pmRoot ? JSON.parse(fs.readFileSync(path.join(pmRoot, 'activation.json'), 'utf8').replace(/^\uFEFF/, '')) : {};
const facts = activation.__HERMES_ACTIVATED ? JSON.parse(fs.readFileSync(activation.__HERMES_ACTIVATED, 'utf8')) : null;
const python = process.env.OMNIA_HERMES_PYTHON || (facts ? path.join(facts.packages.venv.environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') : null);
if (!python) throw new Error('Set OMNIA_HERMES_PM_ROOT to an isolated PM installation or OMNIA_HERMES_PYTHON to its managed interpreter.');
const requests = [];
function summarizeBody(body) {
  try {
    const value = JSON.parse(body);
    return { model: value.model, stream: value.stream, messageRoles: value.messages?.map(m => m.role), messages: value.messages?.filter(m => m.role === 'user'), toolNames: value.tools?.map(t => t.function?.name), bytes: Buffer.byteLength(body), sha256: crypto.createHash('sha256').update(body).digest('hex') };
  } catch { return { bytes: Buffer.byteLength(body), parseError: true }; }
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    requests.push({ method: req.method, path: req.url, headers: req.headers, body });
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const input = JSON.parse(body);
      if (input.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const choice of [
          { index: 0, delta: { role: 'assistant', content: 'OMNIA_HERMES_LOOPBACK_OK' }, finish_reason: null },
          { index: 0, delta: {}, finish_reason: 'stop' },
        ]) res.write(`data: ${JSON.stringify({ id: 'chatcmpl-omnia-hermes', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [choice] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      const payload = { id: 'chatcmpl-omnia-hermes', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'OMNIA_HERMES_LOOPBACK_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload));
    } else { res.writeHead(404); res.end('not found'); }
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const env = {};
  // pm.environments includes inherited environment values; copy only runtime inputs.
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA']);
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toUpperCase())) env[key] = value;
  for (const key of ['PATH', 'PYTHONPATH', 'PLAYWRIGHT_BROWSERS_PATH', '__HERMES_ACTIVATED']) if (activation[key]) env[key] = activation[key];
  Object.assign(env, { HOME: scratch, USERPROFILE: scratch, APPDATA: path.join(scratch, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(scratch, 'AppData', 'Local'), HERMES_HOME: pmRoot ? path.join(pmRoot, 'home') : scratch, NO_COLOR: '1', PYTHONIOENCODING: 'utf-8' });
  if (pmRoot) env.HERMES_RUNTIME_DIR = path.join(pmRoot, 'runtime');
  for (const p of [env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(p, { recursive: true });
  const args = wrapper
    ? [wrapper, 'chat', '--query', 'reply with the marker', '--oneshot', '--provider', 'custom', '--model', 'gpt-4o-mini', '--base-url', `http://127.0.0.1:${port}/v1`, '--api-key', 'loopback-key', '--ignore-user-config', '--format', 'text']
    : ['cli.py', '--query', 'reply with the marker', '--oneshot', '--provider', 'openai', '--model', 'gpt-4o-mini', '--base_url', `http://127.0.0.1:${port}/v1`, '--api_key', 'loopback-key', '--ignore_user_config', '--output_format', 'text'];
  if (wrapper) env.OMNIA_HERMES_PYTHON = python;
  const child = spawn(wrapper ? process.execPath : python, args, { cwd: wrapper ? scratch : target, env, windowsHide: true });
  let stdout = ''; let stderr = '';
  let timedOut = false;
  let spawnError = null;
  child.on('error', error => { spawnError = error.message; });
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill();
  }, 60000);
  child.on('close', code => {
    clearTimeout(timer); server.close();
    // The gateway intentionally outlives viewers. Stop it through the same isolated home.
    const stop = spawnSync(python, ['hermes', 'gateway', 'stop'], { cwd: target, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
    const providerRequestReceived = requests.some(r => r.path === '/v1/chat/completions');
    const markerReturned = stdout.includes('OMNIA_HERMES_LOOPBACK_OK');
    const report = { generatedAt: new Date().toISOString(), python, scratch, hermesHome: env.HERMES_HOME, pmRoot, command: args, process: { exitCode: code, timedOut, spawnError, stdout: stdout.slice(-10000), stderr: stderr.slice(-10000) }, cleanup: { command: ['hermes', 'gateway', 'stop'], exitCode: stop.status, error: stop.error?.message, stdout: stop.stdout?.slice(-4000), stderr: stop.stderr?.slice(-4000) }, requests: requests.map(r => ({ method: r.method, path: r.path, authorizationPresent: Boolean(r.headers.authorization), body: summarizeBody(r.body) })), checks: { pythonAvailable: fs.existsSync(python), providerRequestReceived, markerReturned, childSucceeded: code === 0 && !timedOut && !spawnError, credentialsFromParentExcluded: true, outboundNetworkIsolation: 'not-instrumented' }, conclusion: providerRequestReceived && markerReturned && code === 0 ? 'Hermes upstream CLI reached an OpenAI-compatible mock bound to 127.0.0.1 and handled its response. This proves local provider routing only; real provider credentials/model behavior remain unverified. Other outbound traffic was not instrumented.' : 'Hermes upstream CLI did not complete the loopback provider contract; inspect process and request evidence. Provider behavior remains unverified; other outbound traffic was not instrumented.' };
    const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../artifacts/upstream-ui/hermes-loopback-provider-audit.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); process.exitCode = markerReturned && providerRequestReceived && report.checks.childSucceeded ? 0 : 1;
  });
});
