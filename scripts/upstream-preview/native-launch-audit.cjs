const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../../upstream_extractions');
const electron = path.join(root, 'harnesses/opencode/node_modules/.bun/electron@44.9.1+759ce506b1ed1a42/node_modules/electron/dist/electron.exe');
const apps = [
  { name: 'antigravity-core', dir: path.join(root, 'ide/antigravity-core/app-unpacked') },
  { name: 'cherry-studio', dir: path.join(root, 'desktop-apps/cherry-studio') },
  { name: 'opencode-desktop-shell', dir: path.join(root, 'desktop-apps/opencode-desktop') },
  { name: 'claude-desktop-4.4212.0', dir: path.join(root, 'desktop-apps/claude-desktop/app-unpacked') },
  { name: 'chatgpt-desktop-shell', dir: path.join(root, 'desktop-apps/chatgpt-desktop') },
  { name: 'codex-app-unpacked-26.1027.30824', dir: path.join(root, 'harnesses/codex-app-unpacked') },
];
function launch(app) {
  return new Promise((resolve) => {
    if (!fs.existsSync(electron)) return resolve({ name: app.name, electronMissing: true, runtimeParity: 'unverified' });
    const child = spawn(electron, [app.dir, '--no-sandbox', '--disable-gpu'], { windowsHide: true });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      setTimeout(() => resolve({ name: app.name, electron: path.relative(root, electron).replaceAll('\\', '/'), app: path.relative(root, app.dir).replaceAll('\\', '/'), pid: child.pid, survivedEightSeconds: true, exitCode: null, signal: 'forced-timeout', stdout: stdout.slice(-3000), stderr: stderr.slice(-5000), runtimeParity: 'unverified' }), 1000).unref();
    }, 8000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ name: app.name, electron: path.relative(root, electron).replaceAll('\\', '/'), app: path.relative(root, app.dir).replaceAll('\\', '/'), pid: child.pid, survivedEightSeconds: timedOut, exitCode: code, signal, stdout: stdout.slice(-3000), stderr: stderr.slice(-5000), runtimeParity: 'unverified' });
    });
  });
}
(async () => {
  const appsOut = [];
  for (const app of apps) appsOut.push(await launch(app));
  const report = { generatedAt: new Date().toISOString(), electronBytes: fs.existsSync(electron) ? fs.statSync(electron).size : null, apps: appsOut, conclusion: 'A surviving Electron process and DevTools/log output prove launch-level evidence only. They do not prove UI interaction, IPC, auth, backend, native helper, or behavioral parity.' };
  const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../artifacts/upstream-ui/native-launch-audit.json');
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
})();
