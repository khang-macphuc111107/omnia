// Native packaged desktop audit. This is a focused sample, not the upstream
// verify-openhands full feature-map pass (its browser daemon cannot attach CDP).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const evidence = path.join(root, 'artifacts/upstream-ui');
const pkg = process.env.OMNIA_OPENHANDS_PACKAGE || path.join(os.tmpdir(), 'omnia-openhands-packaged-509babe7e2304fdbae3d4ab0796192c4');
const fromDesktop = createRequire(path.join(root, 'upstream_extractions/harnesses/opencode/packages/desktop/package.json'));
const { chromium } = fromDesktop('playwright');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function port() { for (;;) { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); if (p < 60000) return p; } }
async function until(fn, label, timeout = 600000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await delay(500); } throw Error('Timed out: ' + label); }
async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-openhands-native-ui-'));
  const home = path.join(scratch, 'home');
  const report = { generatedAt: new Date().toISOString(), scratch, packageRoot: pkg, checks: {}, steps: [], requests: [], cleanup: {}, limitations: ['Mock loopback provider; real provider credentials unverified.', 'Other outbound traffic is not instrumented.', 'Focused native UI sample; not complete feature-map verification.'] };
  const output = path.join(evidence, 'openhands-native-ui-replay.json');
  const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  const env = {};
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA']);
  for (const [k,v] of Object.entries(process.env)) if (allowed.has(k.toUpperCase())) env[k.toUpperCase()] = v;
  report.environment = { inheritedPathext: env.PATHEXT };
  // Some controller shells expose only .CPL. where.exe then ignores uvx.exe.
  env.PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL';
  report.environment.auditPathext = env.PATHEXT;
  for (const d of ['AppData/Roaming', 'AppData/Local', 'Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos', 'workspace', 'config', 'data', 'cache', 'state']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const ports = { ingress: await port(), agent: await port(), automation: await port(), vite: await port(), cdp: await port() };
  report.ports = ports;
  const key = crypto.randomBytes(32).toString('hex');
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'), UV_CACHE_DIR: process.env.OMNIA_OPENHANDS_UV_CACHE || path.join(process.env.LOCALAPPDATA || '', 'uv/cache'), PORT: String(ports.ingress), OH_CANVAS_SAFE_BACKEND_PORT: String(ports.agent), OH_CANVAS_SAFE_AUTOMATION_PORT: String(ports.automation), OH_CANVAS_SAFE_VITE_PORT: String(ports.vite), OH_CANVAS_SAFE_STATE_DIR: path.join(scratch, 'state'), LOCAL_BACKEND_API_KEY: key, OH_SECRET_KEY: key, OH_ENABLE_BROWSER: 'false', OH_ENABLE_VSCODE: 'false', DO_NOT_TRACK: '1', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' });
  const marker = 'OMNIA_OPENHANDS_NATIVE_UI_OK';
  const provider = http.createServer((req, res) => { let raw = ''; req.on('data', c => raw += c); req.on('end', () => { let body; try { body = JSON.parse(raw); } catch {} const tools = body?.tools?.map(t => t.function?.name).filter(Boolean) || []; const finish = tools.includes('finish'); report.requests.push({ url: req.url, model: body?.model, stream: body?.stream, messageCount: body?.messages?.length, tools }); save(); const id = 'chatcmpl-omnia-ui'; const base = { id, created: Math.floor(Date.now()/1000), model: body?.model || 'omnia-ui' }; if (body?.stream) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); const call = { index: 0, id: 'call_omnia_finish', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ message: marker }) } }; res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: finish ? { role: 'assistant', tool_calls: [call] } : { role: 'assistant', content: marker }, finish_reason: null }] })}\n\n`); res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`); res.end('data: [DONE]\n\n'); } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: marker }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); } }); });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  report.providerBaseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  let child, browser;
  const logfile = fs.openSync(path.join(evidence, 'openhands-native-ui-replay.log'), 'w');
  try {
    const exe = path.join(pkg, 'OpenHands Agent Canvas.exe');
    report.executable = { path: exe, sha256: crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex') };
    child = spawn(exe, ['--no-sandbox', '--disable-gpu', '--disable-updates', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', `--remote-debugging-port=${ports.cdp}`, `--user-data-dir=${path.join(scratch, 'user-data')}`], { cwd: pkg, env, windowsHide: true, stdio: ['ignore', logfile, logfile] });
    report.pid = child.pid; child.on('exit', c => { report.exitCode = c; save(); }); save();
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${ports.ingress}/server_info`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }, 'Agent Server readiness');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${ports.cdp}`, { noDefaults: true });
    let page;
    await until(async () => { page = browser.contexts()[0].pages().find(p => p.url().startsWith('http://localhost:')); return !!page; }, 'native renderer URL');
    const capture = async name => { const aria = await page.locator('body').ariaSnapshot(); fs.writeFileSync(path.join(evidence, `openhands-native-replay-${name}.aria.txt`), aria); await page.screenshot({ path: path.join(evidence, `openhands-native-replay-${name}.png`) }); report.steps.push({ name, url: page.url(), aria, controls: await page.locator('button,input,textarea,[role=button],[role=tab]').evaluateAll(els => els.map(e => ({ tag: e.tagName, testid: e.getAttribute('data-testid'), role: e.getAttribute('role'), name: e.getAttribute('aria-label') || e.textContent?.trim().slice(0,100) }))) }); save(); return aria; };
    const actions = require('./openhands-native-ui-actions.cjs');
    await actions({ page, report, save, capture, until, marker });
  } catch (e) { report.error = e.stack || String(e); }
  finally {
    if (child?.pid) {
      const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
      // Electron can exit its descendants while taskkill is still walking the
      // tree. A 255 status with only "no running instance" is an idempotent
      // teardown result, not a failed UI audit.
      const alreadyGone = killed.status === 255 && /no running instance/i.test(`${killed.stdout || ''}\n${killed.stderr || ''}`);
      report.cleanup.desktopTree = { status: killed.status, stdout: killed.stdout, stderr: killed.stderr, alreadyGone, ok: killed.status === 0 || alreadyGone };
    }
    await browser?.close().catch(() => {});
    provider.closeAllConnections(); await new Promise(r => provider.close(r));
    fs.closeSync(logfile); report.finishedAt = new Date().toISOString(); save();
  }
  console.log(JSON.stringify({ output, checks: report.checks, error: report.error, cleanup: report.cleanup }, null, 2));
  // A taskkill cleanup can make Electron report exit code 1 after all UI checks
  // have passed. Treat that expected teardown separately from a failed check.
  if (report.error || !Object.keys(report.checks).length || Object.values(report.checks).some(v => v !== true) || report.cleanup.desktopTree?.ok === false) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
