const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

(async () => {
  const workspace = path.resolve(__dirname, '../..');
  const out = path.join(workspace, 'artifacts/upstream-ui');
  const app = path.join(out, 'herdr-download/herdr-app/herdr-app.exe');
  const core = path.join(out, 'herdr-download/herdr-core.exe');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-herdr-persistence-'));
  const appHome = path.join(home, 'app'); fs.mkdirSync(appHome);
  fs.writeFileSync(path.join(appHome, 'settings.json'), JSON.stringify({ core }));
  const env = { ...process.env, HC_SESSION: 'omnia-' + crypto.randomBytes(6).toString('hex'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CONFIG_HOME: path.join(home, 'config'), HERDR_APP_HOME: appHome, HERDR_CORE_DIRS: path.dirname(core), HC_SETTLE_MS: '0' };
  for (const name of ['HC_SOCKET', 'HC_TERMINAL_ID', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) delete env[name];
  const commands = [];
  const run = (exe, args) => { const r = spawnSync(exe, args, { env, cwd: home, encoding: 'utf8', timeout: 15000, windowsHide: true }); const row = { binary: path.basename(exe), args, exitCode: r.status, error: r.error?.message || null, stdout: r.stdout || '', stderr: r.stderr || '' }; commands.push(row); return row; };
  const parse = (row) => { try { return JSON.parse(row.stdout); } catch { return null; } };
  const launch = async () => {
    const child = spawn(app, [], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
    let ready = null; const deadline = Date.now() + 45000;
    while (Date.now() < deadline) { const status = run(app, ['status']); const parsed = parse(status); if (status.exitCode === 0 && parsed && !parsed.error) { ready = status; break; } await delay(500); }
    return { child, ready, log };
  };
  const started = run(core, ['server', 'start']); let first; let second; let address = null; let cleanup = null;
  try {
    first = await launch();
    let created = null;
    if (first.ready) created = run(app, ['do', 'space.new', JSON.stringify({ name: 'Omnia persistence audit', folder: home, tab: 'Restart fixture', argv: ['cmd.exe', '/d', '/c', 'echo OMNIA_HERDR_PERSISTED_PTY'] })]);
    address = parse(created)?.terminal || null;
    const firstLs = run(app, ['ls']);
    const firstStatus = run(app, ['status']);
    spawnSync('taskkill', ['/PID', String(first.child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' }); await delay(500);
    second = await launch();
    const secondLs = run(app, ['ls']);
    const secondStatus = run(app, ['status']);
    const coreLs = run(core, ['ls', '--all']);
    const firstSpaces = parse(firstLs)?.spaces || []; const secondSpaces = parse(secondLs)?.spaces || [];
    const sameSpace = firstSpaces.length > 0 && secondSpaces.some(s => s.id === firstSpaces[0].id && s.name === firstSpaces[0].name);
    const report = { generatedAt: new Date().toISOString(), isolation: { home, HERDR_APP_HOME: appHome, XDG_STATE_HOME: env.XDG_STATE_HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, HC_SESSION: env.HC_SESSION }, sourceClassification: 'official-upstream-release-binary', binaries: { app: { path: 'artifacts/upstream-ui/herdr-download/herdr-app/herdr-app.exe', bytes: fs.statSync(app).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(app)).digest('hex') }, core: { path: 'artifacts/upstream-ui/herdr-download/herdr-core.exe', bytes: fs.statSync(core).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(core)).digest('hex') } }, commands, persistence: { firstLaunchReady: !!first.ready, createdTerminal: !!address, firstSpaceCount: firstSpaces.length, secondLaunchReady: !!second.ready, secondSpaceCount: secondSpaces.length, sameSpaceIdAndName: sameSpace, coreTerminalsAfterRestart: parse(coreLs)?.terminals?.length ?? null, fixtureAddress: address }, checks: { firstLaunchReady: !!first.ready, secondLaunchReady: !!second.ready, createdTerminal: !!address, spaceSurvivedAppRestart: sameSpace }, limitation: 'The app was restarted with the core process kept alive. This establishes app state recovery in the isolated profile, not full core database restart or provider/agent parity.' };
    fs.writeFileSync(path.join(out, 'herdr-desktop-persistence-audit.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
    if (!Object.values(report.checks).every(Boolean)) process.exitCode = 1;
  } finally {
    if (typeof address === 'string') { run(core, ['kill', address]); run(core, ['rm', address]); }
    run(core, ['server', 'stop']); const stopped = run(core, ['server', 'status']); cleanup = { coreStopped: stopped.exitCode !== 0 };
    for (const session of [first, second]) if (session?.child && !session.child.killed) spawnSync('taskkill', ['/PID', String(session.child.pid), '/T', '/F'], { windowsHide: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
