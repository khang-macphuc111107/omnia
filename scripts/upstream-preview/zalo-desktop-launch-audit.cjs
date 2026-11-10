const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto'); const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../../upstream_extractions'); const app = path.join(root, 'desktop-apps/zalo-desktop/app-unpacked'); const main = path.join(app, 'main-dist/main.js'); const electron = path.join(root, 'harnesses/opencode/node_modules/.bun/electron@44.9.1+759ce506b1ed1a42/node_modules/electron/dist/electron.exe');
const timeoutMs = 10000;
function runBounded() {
  return new Promise((resolve) => {
    const child = spawn(electron, [app, '--no-sandbox', '--disable-gpu'], { encoding: 'utf8', windowsHide: true });
    let stdout = ''; let stderr = ''; let timedOut = false; let spawnError = null; let settled = false;
    child.stdout?.on('data', (x) => { stdout += x; }); child.stderr?.on('data', (x) => { stderr += x; });
    child.once('error', (e) => { spawnError = { code: e.code, message: e.message }; });
    const timer = setTimeout(() => {
      timedOut = true;
      let cleanup = null;
      try { child.kill(); cleanup = { kill: true }; } catch (e) { cleanup = { kill: false, error: e.message }; }
      if (process.platform === 'win32' && child.pid) {
        try { require('node:child_process').execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); cleanup.taskkill = true; }
        catch (e) { cleanup.taskkill = false; cleanup.taskkillError = e.message; }
      }
      if (!settled) { settled = true; resolve({ stdout, stderr, timedOut, spawnError, exitCode: null, signal: null, cleanup }); }
    }, timeoutMs);
    child.once('close', (code, signal) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ stdout, stderr, timedOut, spawnError, exitCode: code, signal, cleanup: null }); });
  });
}
(async () => {
  const r = await runBounded(); const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  const report = { generatedAt: new Date().toISOString(), package: JSON.parse(fs.readFileSync(path.join(app, 'package.json'))), main: { path: 'desktop-apps/zalo-desktop/app-unpacked/main-dist/main.js', bytes: fs.statSync(main).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(main)).digest('hex') }, launch: { electron: 'OpenCode Electron 44.9.1', timeoutMs, timedOut: r.timedOut, exitCode: r.exitCode, signal: r.signal, spawnError: r.spawnError, cleanup: r.cleanup, observed: ['webContents.incrementCapturerCount is not a function', 'UnhandledPromiseRejectionWarning'].map((x) => ({ marker: x, observed: text.includes(x) })), outputTail: text.slice(-2500), runtimeParity: 'unverified' }, conclusion: r.timedOut ? 'Zalo main process stayed alive until the bounded timeout; the captured log includes only launch-level evidence and must not be treated as a healthy UI/runtime pass.' : 'Zalo launch exited within the bounded window; inspect exit code and captured output before making runtime claims.' };
  const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../artifacts/upstream-ui/zalo-desktop-launch-audit.json'); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
})();
