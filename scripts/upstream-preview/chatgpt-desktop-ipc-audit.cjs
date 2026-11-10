const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '../../upstream_extractions/desktop-apps/chatgpt-desktop');
const { ChatGptIpcHandlers } = require(path.join(root, 'dist/ipc-handlers.js'));
const { ChatGptWindowManager } = require(path.join(root, 'dist/window.js'));
const { ChatgptDesktopBridge } = require(path.join(root, 'dist/preload.js'));

const checks = {};
const events = [];
async function main() {
  const ipc = new ChatGptIpcHandlers();
  ipc.on('settings-changed', value => events.push({ type: 'settings-changed', value }));
  ipc.on('open-url', url => events.push({ type: 'open-url', url }));
  ipc.on('render-canvas', artifact => events.push({ type: 'render-canvas', id: artifact.id }));
  ipc.register();
  const get = await ipc.dispatch({ id: 'get', channel: 'desktop:get-settings', payload: {} });
  checks.settingsRead = get.success && get.data.theme === 'dark' && get.data.telemetryEnabled === false;
  const update = await ipc.dispatch({ id: 'update', channel: 'desktop:update-settings', payload: { theme: 'light', telemetryEnabled: true } });
  checks.settingsUpdate = update.success && update.data.theme === 'light' && update.data.telemetryEnabled === true && events.some(e => e.type === 'settings-changed');
  const invalidSettings = await ipc.dispatch({ id: 'invalid-settings', channel: 'desktop:update-settings', payload: { theme: 'neon', telemetryEnabled: 'yes' } });
  checks.settingsValidation = !invalidSettings.success && invalidSettings.error.includes('theme');
  const voice = await ipc.dispatch({ id: 'voice', channel: 'desktop:voice-session', payload: { sessionId: 'audit-voice', token: 'isolated-token' } });
  checks.voiceSession = voice.success && voice.data.sessionId === 'audit-voice' && voice.data.codec === 'audio/pcm';
  const extBad = await ipc.dispatch({ id: 'ext-bad', channel: 'desktop:open-external', payload: { url: 'file:///secret' } });
  const extGood = await ipc.dispatch({ id: 'ext-good', channel: 'desktop:open-external', payload: { url: 'https://example.invalid/' } });
  const extMalformed = await ipc.dispatch({ id: 'ext-malformed', channel: 'desktop:open-external', payload: { url: 'https://' } });
  checks.externalUrlValidation = !extBad.success && extBad.error === 'Invalid external URL' && !extMalformed.success && extGood.success && events.some(e => e.type === 'open-url');
  const canvasBad = await ipc.dispatch({ id: 'canvas-bad', channel: 'desktop:canvas-artifact', payload: { id: 'x' } });
  const canvasGood = await ipc.dispatch({ id: 'canvas-good', channel: 'desktop:canvas-artifact', payload: { id: 'x', content: '# audit', version: 3 } });
  checks.canvasValidation = !canvasBad.success && canvasGood.success && canvasGood.data.version === 3 && events.some(e => e.type === 'render-canvas');
  const missing = await ipc.dispatch({ id: 'missing', channel: 'desktop:not-registered', payload: {} });
  checks.missingChannel = !missing.success && missing.error.includes('No handler');
  const manager = new ChatGptWindowManager();
  const win = manager.createWindow('audit', { title: 'Audit Window', width: 900, height: 700 });
  checks.windowSecurityDefaults = win.config.webPreferences.nodeIntegration === false && win.config.webPreferences.contextIsolation === true && win.config.webPreferences.sandbox === true;
  await win.loadURL('https://chatgpt.com');
  checks.windowLifecycle = manager.getAllWindows().length === 1 && manager.getWindow('audit').id === 'audit';
  win.close();
  checks.windowClose = win.isDestroyed && manager.getAllWindows().length === 0;
  const bridgeSettings = await ChatgptDesktopBridge.getSettings();
  const bridgeVoice = await ChatgptDesktopBridge.startVoiceSession('bridge-token');
  checks.bridgeCalls = bridgeSettings.channel === 'desktop:get-settings' && bridgeVoice.channel === 'desktop:voice-session';
  const report = {
    generatedAt: new Date().toISOString(),
    evidenceKind: 'executed-ipc-window-bridge-contract',
    source: { root: 'upstream_extractions/desktop-apps/chatgpt-desktop', files: ['dist/ipc-handlers.js', 'dist/window.js', 'dist/preload.js'].map(file => ({ path: file, bytes: fs.statSync(path.join(root, file)).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') })) },
    checks,
    passed: Object.values(checks).filter(Boolean).length,
    total: Object.keys(checks).length,
    events,
    limitations: ['The package is explicitly reconstructed; this proves its local IPC/window/bridge contract only.', 'No real Electron renderer, ChatGPT account, provider session, auth, or upstream packaged parity is claimed.', 'The window manager is a mock and does not instantiate an Electron BrowserWindow.'],
    conclusion: Object.values(checks).every(Boolean) ? 'All reconstructed ChatGPT desktop IPC, window security/lifecycle and preload bridge checks passed locally; upstream/provider parity remains unverified.' : 'One or more reconstructed ChatGPT desktop contract checks failed; inspect checks.'
  };
  const out = path.resolve(process.argv[2] || path.join(__dirname, '../../artifacts/upstream-ui/chatgpt-desktop-ipc-audit.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
