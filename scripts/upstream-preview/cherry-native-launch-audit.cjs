const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

(async () => {
  const workspace = path.resolve(__dirname, '../..');
  const root = path.join(workspace, 'upstream_extractions/desktop-apps/cherry-studio');
  const out = path.join(workspace, 'artifacts/upstream-ui');
  const exe = path.join(root, 'node_modules/electron/dist/electron.exe');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-cherry-native-'));
  const stopFile = path.join(out, 'cherry-native-launch.stop');
  if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile);
  const userHome = path.join(home, 'home');
  for (const dir of ['AppData/Roaming', 'AppData/Local', 'Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos']) fs.mkdirSync(path.join(userHome, dir), { recursive: true });
  const env = { ...process.env, CS_DEV_PROFILE_ROOT: home, USERPROFILE: userHome, HOME: userHome, APPDATA: path.join(userHome, 'AppData/Roaming'), LOCALAPPDATA: path.join(userHome, 'AppData/Local') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ELECTRON_OVERRIDE_DIST_PATH']) delete env[key];
  const file = (p) => ({ path: path.relative(workspace, p).replaceAll('\\', '/'), bytes: fs.statSync(p).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const logPath = path.join(out, 'cherry-native-launch.log');
  const reportPath = path.join(out, 'cherry-native-launch-audit.json');
  let log = ''; let exited = false; let exitCode = null; let launchError = null;
  const child = spawn(exe, [root], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (data) => { log += data; fs.appendFileSync(logPath, data); });
  child.stderr.on('data', (data) => { log += data; fs.appendFileSync(logPath, data); });
  child.on('exit', (code) => { exited = true; exitCode = code; });
  child.on('error', (error) => { exited = true; launchError = error.message; });
  fs.writeFileSync(logPath, '');
  const report = {
    generatedAt: new Date().toISOString(), provenance: { repository: pkg.homepage, revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), version: pkg.version, classification: 'upstream-source-with-built-artifacts' },
    command: { executable: file(exe), args: [root], cwd: root, electronVersion: fs.readFileSync(path.join(root, 'node_modules/electron/dist/version'), 'utf8').trim() },
    isolation: { CS_DEV_PROFILE_ROOT: home, USERPROFILE: userHome, HOME: userHome, APPDATA: env.APPDATA, LOCALAPPDATA: env.LOCALAPPDATA, expectedSkillExportRoot: path.join(userHome, '.agents/skills'), expectedUserData: path.join(home, 'userData'), expectedLogs: path.join(home, 'logs'), stopFile },
    artifacts: { main: file(path.join(root, pkg.main)), preload: file(path.join(root, 'out/preload/preload.js')), renderer: file(path.join(root, 'out/renderer/windows/main/index.html')) },
    process: { ownedPid: child.pid, terminal: false }, uiEvidence: 'separate computer-use observations required', runtimeParity: 'unverified'
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ownedPid: child.pid, home, stopFile, reportPath }));
  const deadline = Date.now() + 600000;
  while (!exited && !fs.existsSync(stopFile) && Date.now() < deadline) await delay(500);
  const cleanupReason = exited ? 'app-exited' : fs.existsSync(stopFile) ? 'requested-audit-cleanup' : 'audit-deadline';
  let cleanup = null;
  if (!exited) {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
    cleanup = { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    await delay(500);
  }
  report.completedAt = new Date().toISOString();
  report.process = { ownedPid: child.pid, terminal: exited, exitCode, launchError, cleanupReason, cleanup };
  report.isolation.profileCreated = fs.existsSync(path.join(home, 'userData'));
  report.log = file(logPath);
  const appLogDir = path.join(home, 'logs');
  report.appLogs = [];
  if (fs.existsSync(appLogDir)) {
    for (const entry of fs.readdirSync(appLogDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
      const copy = path.join(out, 'cherry-native-' + entry.name);
      fs.copyFileSync(path.join(appLogDir, entry.name), copy);
      report.appLogs.push(file(copy));
    }
  }
  report.conclusion = 'Direct native Electron launch of compiled upstream code in its documented scratch dev profile. UI, native database, IPC and provider behavior require their own observations; process lifetime alone does not establish parity.';
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ terminal: exited, exitCode, launchError, cleanupReason, outputTail: log.slice(-2500) }));
  if (launchError || (cleanupReason === 'app-exited' && exitCode !== 0)) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
