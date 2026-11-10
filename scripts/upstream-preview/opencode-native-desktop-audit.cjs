// Official OpenCode main/preload/renderer + source CLI, with disposable state.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const upstream = path.join(root, 'upstream_extractions/harnesses/opencode');
const app = path.join(upstream, 'packages/desktop');
const wrapper = path.join(root, 'upstream_extractions/desktop-apps/opencode-desktop/dist/main.js');
const bun = path.join(root, '.toolchains/bun-1.4.4/package/bin/bun.exe');
const fromUpstream = createRequire(path.join(app, 'package.json'));
const { chromium } = fromUpstream('playwright');
const evidence = path.join(root, 'artifacts/upstream-ui');
const out = path.resolve(process.argv[2] || path.join(evidence, 'opencode-native-desktop-audit.json'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-opencode-native-replay-'));
const report = {
  generatedAt: new Date().toISOString(), scratch,
  classification: 'official-source-desktop-via-omnia-launcher',
  checks: {}, requests: [], steps: [], launches: [], cleanup: {},
  limitations: ['Mock loopback provider only; real providers unverified.',
    'Other outbound traffic is not instrumented.',
    'Source runtime only; packaged installer and complete UI/tool parity unverified.'],
};
function save() { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); }
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(200); }
  throw new Error(`Timed out: ${label}`);
}
async function port() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sourceStatus = () => spawnSync('git', ['status', '--porcelain'], { cwd: upstream, encoding: 'utf8' }).stdout;
const sourceBefore = sourceStatus();
const dirtyPaths = spawnSync('git', ['diff', '--name-only', '-z'], { cwd: upstream, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
const dirtyBefore = dirtyPaths.map(f => ({ path: f, sha256: hash(path.join(upstream, f)) }));
const env = {};
const allowed = new Set(['SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP','OS','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA']);
for (const [k, v] of Object.entries(process.env)) if (allowed.has(k.toUpperCase())) env[k.toUpperCase()] = v;
Object.assign(env, {
  PATH: path.dirname(bun) + path.delimiter + env.PATH,
  HOME: scratch, USERPROFILE: scratch,
  APPDATA: path.join(scratch, 'AppData/Roaming'), LOCALAPPDATA: path.join(scratch, 'AppData/Local'),
  OMNIA_OPENCODE_HOME: scratch, OPENCODE_DESKTOP_TEST_ROOT: scratch,
  OPENCODE_DESKTOP_DISABLE_PROTOCOL_REGISTRATION: '1',
  OPENCODE_DESKTOP_CLI_DEV: path.join(upstream, 'packages/cli'),
  OPENCODE_DESKTOP_SERVER_CHANNEL: 'local',
  OPENCODE_VERSION: '2.2.5-omnia-source', OPENCODE_CHANNEL: 'local',
  OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_TEST_HOME: scratch,
});
for (const d of [env.APPDATA, env.LOCALAPPDATA, path.join(scratch, 'workspace'), path.join(scratch, 'config/opencode')]) fs.mkdirSync(d, { recursive: true });
// The current desktop shell treats an empty userData directory as a first-launch
// onboarding flow and keeps the main composer hidden until that flow is completed.
// Native replay starts from an already configured installation, so seed the same
// durable marker that the production install-state probe recognizes.
fs.mkdirSync(path.join(scratch, 'desktop'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'desktop', 'opencode.settings'), '{}\n');
const state = { mode: 'normal', held: null, child: null, browser: null, log: null, toolSent: false };
const marker = 'OMNIA_OPENCODE_DESKTOP_OK';
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', b => raw += b); req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const record = { at: new Date().toISOString(), method: req.method, path: req.url,
      scenario: state.mode, model: body.model, stream: body.stream,
      roles: body.messages?.map(m => m.role), tools: body.tools?.map(t => t.function?.name) };
    if (state.mode === 'tool') record.toolResults = body.messages?.filter(m => m.role === 'tool');
    report.requests.push(record); save();
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    if (state.mode === 'denied') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'OMNIA_OPENCODE_AUDIT_DENIED', type: 'authentication_error', code: 'invalid_api_key' } })); return;
    }
    const content = state.mode === 'tool' ? 'OMNIA_OPENCODE_TOOL_ROUNDTRIP_OK' : marker;
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'audit', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] })); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'native-audit', object: 'chat.completion.chunk', model: 'qwen', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (state.mode === 'hold') {
      const held = { startedAt: Date.now(), closedAt: null }; state.held = held;
      res.on('close', () => { held.closedAt = Date.now(); report.cancellation = held; save(); });
      chunk({ role: 'assistant', content: 'OMNIA_OPENCODE_CANCEL_PENDING' }); return;
    }
    if (state.mode === 'tool' && !state.toolSent) {
      if (!record.tools?.includes('shell')) { report.toolSchemaMissing = true; save(); res.end('data: [DONE]\n\n'); return; }
      state.toolSent = true;
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_omnia_shell', type: 'function', function: {
        name: 'shell', arguments: JSON.stringify({ command: 'echo OMNIA_OPENCODE_SHELL_OK', workdir: path.join(scratch, 'workspace') }),
      } }] }); chunk({}, 'tool_calls');
    } else { chunk({ role: 'assistant', content }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
});
async function capture(page, name) {
  const prefix = `opencode-native-replay-${name}`;
  const aria = await page.locator('body').ariaSnapshot();
  await page.screenshot({ path: path.join(evidence, prefix + '.png') });
  fs.writeFileSync(path.join(evidence, prefix + '.aria.txt'), aria);
  const controls = await page.locator('button,input,textarea,a,[role="tab"],[role="menuitem"],[contenteditable="true"]').evaluateAll(es => es.map(e => ({ tag: e.tagName, role: e.getAttribute('role'), label: e.getAttribute('aria-label'), text: e.textContent?.slice(0, 180), disabled: e.hasAttribute('disabled') })));
  report.steps.push({ name, at: new Date().toISOString(), url: page.url(), aria, controls, screenshot: prefix + '.png' }); save();
}
async function launch(cdp) {
  const logPath = path.join(scratch, `launch-${report.launches.length + 1}.log`);
  state.log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [wrapper, '--no-sandbox', '--disable-gpu', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], { cwd: scratch, env, stdio: ['ignore', state.log, state.log], windowsHide: true });
  state.child = child;
  const launch = { pid: child.pid, logPath, exitCode: null }; report.launches.push(launch); save();
  child.on('exit', code => { launch.exitCode = code; save(); });
  child.on('error', e => { launch.error = e.message; save(); });
  await until(async () => { try { state.browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp}`, { noDefaults: true }); return true; } catch { return false; } }, 'native CDP');
  const page = state.browser.contexts().flatMap(c => c.pages()).find(p => !p.url().startsWith('devtools:'));
  // A fresh configured installation opens on the Home screen. Start an explicit
  // session before looking for the composer; waiting for the textbox directly
  // made the audit report a false startup failure even though the app was ready.
  const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true });
  const home = page.getByRole('button', { name: 'Home', exact: true });
  if ((await home.getAttribute('aria-pressed').catch(() => null)) === 'true' || !(await prompt.isVisible().catch(() => false))) {
    const newSession = page.locator('[data-action="home-new-session"]').first();
    if (await newSession.count()) await newSession.click({ force: true });
    else await page.getByRole('button', { name: 'New session', exact: true }).click({ force: true });
    await delay(500);
  }
  await prompt.waitFor({ timeout: 60000 });
  await page.bringToFront(); return page;
}
async function send(page, text) {
  await page.bringToFront();
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill(text);
  await capture(page, `composer-${report.requests.length}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function fileMenu(page) { await page.getByRole('button', { name: 'OpenCode menu', exact: true }).click(); await page.getByRole('menuitem', { name: 'File', exact: true }).hover(); }
async function close(page) {
  await fileMenu(page); await page.getByRole('menuitem', { name: 'Close Window Ctrl+Shift+W', exact: true }).click();
  await until(() => state.child.exitCode !== null, 'graceful desktop exit');
  if (state.browser) await state.browser.close().catch(() => {}); state.browser = null;
  if (state.log !== null) fs.closeSync(state.log); state.log = null; state.child = null;
}
function stopService() {
  const file = path.join(scratch, '.local/state/opencode/service-local.json');
  const module = pathToFileURL(path.join(upstream, 'packages/client/src/promise/service.ts')).href;
  const r = spawnSync(bun, ['-e', `import {Service} from ${JSON.stringify(module)};await Service.stop({file:${JSON.stringify(file)}});`], { cwd: scratch, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  const result = { exitCode: r.status, error: r.error?.message, stderr: r.stderr?.slice(-2000) };
  report.cleanup.service = result; save(); return result;
}
(async () => {
  try {
    const mockPort = await port(), cdp = await port(), servicePort = await port();
    env.OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT = String(cdp);
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'omnia/qwen', provider: { omnia: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'loopback-key' }, models: { qwen: { name: 'Omnia Qwen' } } } } });
    report.isolation = { mock: `127.0.0.1:${mockPort}`, service: `127.0.0.1:${servicePort}`, cdp, credentialsFromParentExcluded: true };
    report.provenance = { launcherNode: process.version, launcherExecutable: process.execPath, runtimePathPreserved: env.PATH.endsWith(process.env.PATH), revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).stdout.trim(), electron: fromUpstream('electron/package.json').version, files: ['bun.lock','packages/desktop/out/main/index.js','packages/desktop/out/preload/index.cjs','packages/desktop/out/renderer/index.html'].map(f => ({ path: f, sha256: hash(path.join(upstream, f)) })) };
    await new Promise(r => server.listen(mockPort, '127.0.0.1', r));
    let page = await launch(cdp); await capture(page, 'home');
    await send(page, 'Reply with the desktop audit marker.');
    await until(async () => await page.getByText(marker, { exact: true }).count() > 0, 'stream marker');
    report.checks.composerStreaming = true; await capture(page, 'response');
    await page.getByRole('button', { name: 'More options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: '', exact: true }).fill('Omnia OpenCode native replay');
    await page.getByRole('textbox', { name: '', exact: true }).press('Enter');
    await page.getByRole('heading', { name: 'Omnia OpenCode native replay', exact: true }).waitFor(); report.checks.rename = true;
    const sessionLink = page.locator('a[href*="/session/"]').first();
    const href = await sessionLink.getAttribute('href');
    if (!href) throw new Error('Renamed session link did not expose a session URL');
    report.sessionId = href.split('/session/')[1];
    await page.getByRole('button', { name: 'More options', exact: true }).click(); await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click(); await capture(page, 'delete-confirm');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('heading', { name: 'Omnia OpenCode native replay', exact: true }).waitFor({ state: 'visible' });
    report.checks.deleteCanceled = true; await capture(page, 'delete-canceled');
    await page.getByRole('button', { name: 'Search sessions', exact: true }).click(); await page.getByRole('combobox', { name: 'Search sessions', exact: true }).fill('no-such-omnia-483');
    await page.getByText('No results found', { exact: true }).waitFor(); report.checks.searchNegative = true; await capture(page, 'search-empty');
    await page.getByRole('combobox', { name: 'Search sessions', exact: true }).fill('Omnia OpenCode native replay'); await page.getByRole('option').first().waitFor(); await capture(page, 'search-match'); report.checks.searchMatch = true; await page.keyboard.press('Escape');
    state.mode = 'hold'; await send(page, 'Cancellation audit: hold until Stop.'); await until(() => !!state.held, 'held provider'); await capture(page, 'streaming'); const clickedAt = Date.now();
    await page.getByRole('button', { name: 'Stop', exact: true }).click(); await until(() => state.held.closedAt !== null, 'HTTP cancellation'); report.checks.cancelClosedHttp = true; report.cancelLatencyMs = state.held.closedAt - clickedAt; await capture(page, 'canceled');
    state.mode = 'denied'; await send(page, 'Provider authentication error audit.'); await page.getByText('OMNIA_OPENCODE_AUDIT_DENIED', { exact: true }).waitFor(); report.checks.providerErrorVisible = true; await capture(page, 'denied');
    state.mode = 'normal'; const count = await page.getByText(marker, { exact: true }).count(); await send(page, 'Recovery audit: reply with the marker again.'); await until(async () => await page.getByText(marker, { exact: true }).count() > count, 'provider recovery'); report.checks.providerRecovery = true; await capture(page, 'recovered');
    await fileMenu(page); await page.getByRole('menuitem', { name: 'Settings Ctrl+,', exact: true }).click(); await page.getByRole('tab', { name: 'Appearance', exact: true }).click(); await page.getByRole('tabpanel', { name: 'Appearance', exact: true }).getByRole('button', { name: 'System', exact: true }).first().click(); await page.getByRole('option', { name: 'Dark', exact: true }).click(); await capture(page, 'dark-theme'); await page.getByRole('button', { name: 'Back to app', exact: true }).click();
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('OMNIA_OPENCODE_UNSENT_DRAFT'); await capture(page, 'draft'); await close(page); report.checks.gracefulExit = report.launches[0].exitCode === 0; report.coldRestartServiceStop = stopService();
    page = await launch(cdp);
    if (await page.getByRole('heading', { name: 'Omnia OpenCode native replay', exact: true }).count() === 0) {
      const existing = page.locator('a[href*="/session/"]').first();
      if (await existing.count()) await existing.click();
    }
    await page.getByRole('heading', { name: 'Omnia OpenCode native replay', exact: true }).waitFor();
    report.checks.restartDraft = (await page.getByRole('textbox', { name: 'Prompt', exact: true }).innerText()) === 'OMNIA_OPENCODE_UNSENT_DRAFT';
    report.checks.restartTheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme === 'dark');
    await until(async () => await page.getByText(marker, { exact: true }).count() >= 2, 'persisted transcript hydrated');
    report.checks.restartMessages = true; await capture(page, 'cold-restarted');
    state.mode = 'tool'; await send(page, 'Run echo OMNIA_OPENCODE_SHELL_OK in the audit workspace and report the output.');
    await until(async () => {
      if (await page.getByRole('button', { name: 'Allow once', exact: true }).count()) { await capture(page, 'shell-permission'); await page.getByRole('button', { name: 'Allow once', exact: true }).click(); report.shellPermissionAllowedOnce = true; }
      return report.requests.some(r => r.scenario === 'tool' && r.toolResults?.length);
    }, 'shell tool result', 60000);
    const toolResults = report.requests.flatMap(r => r.toolResults || []); report.checks.shellOutputReturnedToModel = JSON.stringify(toolResults).includes('OMNIA_OPENCODE_SHELL_OK');
    await page.getByText('OMNIA_OPENCODE_TOOL_ROUNDTRIP_OK', { exact: true }).waitFor(); report.checks.shellRoundtripVisible = true; await capture(page, 'tool-roundtrip');
    await close(page);
    const failed = Object.entries(report.checks).filter(([, passed]) => !passed).map(([name]) => name);
    if (failed.length) throw new Error(`Failed measured checks: ${failed.join(', ')}`);
  } catch (error) {
    report.error = error.stack; process.exitCode = 1;
    const failedPage = state.browser?.contexts().flatMap(c => c.pages()).find(p => !p.url().startsWith('devtools:'));
    if (failedPage) await capture(failedPage, 'failure').catch(e => report.failureCaptureError = e.message);
  }
  finally {
    if (state.browser) await state.browser.close().catch(() => {});
    if (state.child?.pid && state.child.exitCode === null) { const r = spawnSync('taskkill', ['/PID', String(state.child.pid), '/T', '/F'], { windowsHide: true }); report.cleanup.forcedDesktopExit = r.status; }
    if (state.log !== null) fs.closeSync(state.log);
    stopService(); server.closeAllConnections(); await new Promise(r => server.close(r));
    report.sourcePreservation = { dirtyBefore, statusUnchanged: sourceStatus() === sourceBefore, dirtyBytesUnchanged: dirtyBefore.every(f => hash(path.join(upstream, f.path)) === f.sha256) };
    for (let i = 0; i < report.launches.length; i++) {
      const name = `opencode-native-replay-launch-${i + 1}.log`;
      fs.copyFileSync(report.launches[i].logPath, path.join(evidence, name)); report.launches[i].savedLog = name;
    }
    if (report.cleanup.service?.exitCode !== 0 || !report.sourcePreservation.statusUnchanged || !report.sourcePreservation.dirtyBytesUnchanged) process.exitCode = 1;
    report.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify({ report: out, checks: report.checks, error: report.error, cleanup: report.cleanup }, null, 2));
  }
})();
