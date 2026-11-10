const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const extensionPath = path.resolve(process.env.IDM_EXTENSION_PATH || path.join(__dirname, '../../upstream_extractions/downloaders/idm-multistream/unpacked_browser_extensions/IDMOpExt'));
const out = path.resolve(process.env.IDM_AUDIT_OUT || path.join(__dirname, '../../artifacts/upstream-ui/idm-electron-extension-runtime.json'));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out + '.started', new Date().toISOString() + '\n');
const events = [];
const record = (kind, value) => events.push({ at: new Date().toISOString(), kind, value: String(value) });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-idm-extension-'));
const partition = 'persist:omnia-idm-extension-audit';
try {
  app.setPath('userData', path.join(scratch, 'userData'));
  app.setPath('sessionData', path.join(scratch, 'sessionData'));
} catch (error) {
  record('path-error', error.stack || error.message);
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), extensionPath, scratch, partition, events, runtime: 'Electron 44.9.1 isolated session.loadExtension', nativeHost: 'not provided', conclusion: 'Electron path isolation failed before app readiness.' }, null, 2) + '\\n');
  throw error;
}

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(async () => {
  const isolatedSession = session.fromPartition(partition, { cache: true });
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: false, partition } });
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => record(`renderer-console-${level}`, `${message} @${sourceId}:${line}`));
  try {
    const loaded = await Promise.race([
      isolatedSession.loadExtension(extensionPath, { allowFileAccess: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loadExtension timeout after 8000ms')), 8000)),
    ]);
    record('loaded', `${loaded.name} ${loaded.version} id=${loaded.id}`);
  } catch (error) { record('load-error', error.stack || error.message); }
  const fixture = path.join(path.dirname(out), 'idm-electron-fixture.html');
  fs.writeFileSync(fixture, '<!doctype html><html><head><title>Omnia IDM fixture</title></head><body><video id="fixture-video"></video></body></html>');
  await win.loadFile(fixture);
  try { record('content-script-init', await win.webContents.executeJavaScript('String(window.__idm_init__)')); }
  catch (error) { record('content-script-check-error', error.stack || error.message); }
  setTimeout(async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
    const loaded = events.some(e => e.kind === 'loaded');
    const result = { generatedAt: new Date().toISOString(), extensionPath, scratch, userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), partition, manifest, events, runtime: 'Electron 44.9.1 isolated session.loadExtension', nativeHost: 'not provided', conclusion: loaded ? `MV${manifest.manifest_version} IDM extension loaded into an isolated Electron runtime; background/native host behavior requires separate probes.` : `MV${manifest.manifest_version} IDM extension did not load in the isolated Electron runtime; inspect events for the fail-closed reason.` };
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result, null, 2));
    await app.quit();
  }, 12000);
}).catch((error) => {
  record('ready-error', error.stack || error.message);
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), extensionPath, scratch, userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), partition, events, runtime: 'Electron 44.9.1 isolated session.loadExtension', nativeHost: 'not provided', conclusion: 'Electron app readiness failed; inspect events.' }, null, 2) + '\\n');
  app.exit(1);
});
