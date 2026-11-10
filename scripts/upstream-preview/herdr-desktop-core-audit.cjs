const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

(async () => {
  const workspace = path.resolve(__dirname, '../..');
  const out = path.join(workspace, 'artifacts/upstream-ui');
  const sourceCore = process.argv.includes('--source-core');
  const core = sourceCore ? path.join(workspace, 'upstream_extractions/harnesses/herdr-core/target/debug/herdr-core.exe') : path.join(out, 'herdr-download/herdr-core.exe');
  const sourceBuild = process.argv.includes('--source');
  const variant = (sourceBuild ? 'source' : 'release') + (sourceCore ? '-with-source-core' : '');
  const app = sourceBuild ? path.join(workspace, 'upstream_extractions/desktop-apps/herdr-app/target/debug/herdr-app.exe') : path.join(out, 'herdr-download/herdr-app/herdr-app.exe');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-herdr-integrated-'));
  const appHome = path.join(home, 'app'); fs.mkdirSync(appHome);
  fs.writeFileSync(path.join(appHome, 'settings.json'), JSON.stringify({ core }));
  const env = { ...process.env, HC_SESSION: 'omnia-' + crypto.randomBytes(6).toString('hex'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CONFIG_HOME: path.join(home, 'config'), HERDR_APP_HOME: appHome, HERDR_CORE_DIRS: path.dirname(core), HC_SETTLE_MS: '0' };
  for (const name of ['HC_SOCKET', 'HC_TERMINAL_ID', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) delete env[name];
  const commands = [];
  const run = (exe, args) => {
    const r = spawnSync(exe, args, { env, cwd: home, encoding: 'utf8', timeout: 10000, windowsHide: true });
    const row = { binary: path.basename(exe), args, exitCode: r.status, error: r.error?.message || null, stdout: r.stdout || '', stderr: r.stderr || '' }; commands.push(row); return row;
  };
  const parse = (row) => { try { return JSON.parse(row.stdout); } catch { return null; } };
  const started = run(core, ['server', 'start']);
  let child; let closed = false; let appExitCode = null; let appError = null; let appLog = ''; let ready = null; let shot = null; let cleanup = null; let terminalShot = null; let terminalListing = null; let fixtureScreen = null; let fixtureAddress = null;
  try {
    if (started.exitCode === 0) {
      child = spawn(app, [], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (b) => { appLog += b; }); child.stderr.on('data', (b) => { appLog += b; });
      child.on('error', (e) => { appError = e.message; closed = true; }); child.on('exit', (code) => { appExitCode = code; closed = true; });
      const deadline = Date.now() + 45000;
      while (!closed && Date.now() < deadline) {
        const status = run(app, ['status']);
        if (status.exitCode === 0 && parse(status) && !parse(status).error) { ready = status; break; }
        await delay(1000);
      }
      if (ready) {
        run(app, ['ls']);
        shot = run(app, ['shot', path.join(out, `herdr-desktop-${variant}.png`)]);
        run(app, ['do', 'overlay.close', JSON.stringify({ id: 'frame-welcome' })]);
        const created = run(app, ['do', 'space.new', JSON.stringify({ name: 'Omnia native audit', folder: home, tab: 'PTY probe', argv: ['cmd.exe', '/d', '/c', 'echo OMNIA_HERDR_DESKTOP_PTY_OK'] })]);
        if (created.exitCode === 0) {
          fixtureAddress = parse(created)?.terminal;
          await delay(1000);
          terminalListing = run(core, ['ls', '--all']);
          if (typeof fixtureAddress === 'string') fixtureScreen = run(core, ['read', fixtureAddress]);
          run(app, ['status']); run(app, ['ls']);
          terminalShot = run(app, ['shot', path.join(out, `herdr-desktop-${variant}-terminal.png`)]);
        }
      }
    }
  } finally {
    const aliveBeforeCleanup = !!child && !closed;
    if (aliveBeforeCleanup) {
      const r = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' }); cleanup = { exitCode: r.status, output: r.stdout || r.stderr };
      await delay(300);
    }
    if (typeof fixtureAddress === 'string') { run(core, ['kill', fixtureAddress]); run(core, ['rm', fixtureAddress]); }
    run(core, ['server', 'stop']);
    const stopped = run(core, ['server', 'status']);
    fs.writeFileSync(path.join(out, `herdr-desktop-${variant}.log`), appLog);
    const report = { generatedAt: new Date().toISOString(), isolation: { home, HC_SESSION: env.HC_SESSION, HERDR_APP_HOME: appHome, XDG_STATE_HOME: env.XDG_STATE_HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME },
      sourceClassification: sourceBuild ? 'locally-built-upstream-source' : 'official-upstream-release-binary', binaryPath: path.relative(workspace, app).replaceAll('\\', '/'), binarySha256: crypto.createHash('sha256').update(fs.readFileSync(app)).digest('hex'),
      core: { classification: sourceCore ? 'locally-built-upstream-source' : 'official-upstream-release-binary', binaryPath: path.relative(workspace, core).replaceAll('\\', '/'), binarySha256: crypto.createHash('sha256').update(fs.readFileSync(core)).digest('hex') },
      commands, process: { ownedPid: child?.pid, aliveBeforeCleanup, appExitCode, appError, cleanup },
      appControlResponded: !!ready, appStatus: ready ? parse(ready) : null,
      screenshot: shot?.exitCode === 0 && fs.existsSync(path.join(out, `herdr-desktop-${variant}.png`)) ? `artifacts/upstream-ui/herdr-desktop-${variant}.png` : null,
      terminalScreenshot: terminalShot?.exitCode === 0 ? `artifacts/upstream-ui/herdr-desktop-${variant}-terminal.png` : null,
      desktopCreatedTerminalProducedFixture: fixtureScreen?.exitCode === 0 && fixtureScreen.stdout.includes('OMNIA_HERDR_DESKTOP_PTY_OK'),
      coreStopped: stopped.exitCode !== 0 && stopped.stderr.includes('unavailable'), runtimeParity: 'unverified', conclusion: `Isolated upstream desktop with ${sourceCore ? 'locally built' : 'official release'} core: command response, native frame and terminal fixture are recorded independently. Full UI, provider and behavioral parity remain unverified.` };
    fs.writeFileSync(path.join(out, `herdr-desktop-${variant}-core-audit.json`), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (!report.appControlResponded || !report.desktopCreatedTerminalProducedFixture || !report.coreStopped || !report.screenshot || !report.terminalScreenshot) process.exitCode = 1;
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
