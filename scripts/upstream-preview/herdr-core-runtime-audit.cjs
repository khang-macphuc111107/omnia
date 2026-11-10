const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const workspace = path.resolve(__dirname, '../..');
const sourceBuild = process.argv.includes('--source');
const exe = path.join(workspace, sourceBuild ? 'upstream_extractions/harnesses/herdr-core/target/debug/herdr-core.exe' : 'artifacts/upstream-ui/herdr-download/herdr-core.exe');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-herdr-core-'));
const session = 'omnia-' + crypto.randomBytes(6).toString('hex');
const env = { ...process.env, HC_SESSION: session, XDG_STATE_HOME: path.join(home, 'state'), XDG_CONFIG_HOME: path.join(home, 'config'), HC_SETTLE_MS: '0' };
for (const name of ['HC_SOCKET', 'HC_TERMINAL_ID', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) delete env[name];
const commands = [];
const run = (args) => {
  const result = spawnSync(exe, args, { cwd: home, env, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  const row = { args, exitCode: result.status, error: result.error?.message || null, stdout: result.stdout || '', stderr: result.stderr || '' };
  commands.push(row); return row;
};
const parse = (row) => { try { return JSON.parse(row.stdout); } catch { return null; } };
let started; let status; let exec; let failure; let invalidTerminal; let terminal; let screen; let terminalInfo; let fixtureAddress;
try {
  run(['--version']);
  run(['--help']);
  started = run(['server', 'start']);
  status = run(['server', 'status']);
  if (started.exitCode === 0 && status.exitCode === 0) {
    exec = run(['exec', 'cmd.exe', '/d', '/c', 'echo OMNIA_HERDR_EXEC_OK']);
    failure = run(['exec', 'cmd.exe', '/d', '/c', 'exit 7']);
    invalidTerminal = run(['run', '--bg', '--name', 'Invalid name with spaces', 'cmd.exe', '/d', '/c', 'echo SHOULD_NOT_RUN']);
    terminal = run(['run', '--bg', '--name', 'omnia-pty', 'cmd.exe', '/d', '/c', 'echo OMNIA_HERDR_PTY_OK']);
    const address = parse(terminal)?.address; fixtureAddress = address;
    if (typeof address === 'string') {
      run(['wait', address]);
      screen = run(['read', address]);
      terminalInfo = run(['get', address]);
    }
  }
} finally {
  if (typeof fixtureAddress === 'string') { run(['kill', fixtureAddress]); run(['rm', fixtureAddress]); }
  const stop = run(['server', 'stop']);
  const stopped = run(['server', 'status']);
  const source = path.join(workspace, 'upstream_extractions/harnesses/herdr-core');
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' });
  const report = { generatedAt: new Date().toISOString(), provenance: { repository: 'https://github.com/herdrdev/herdr-core', sourceCheckoutRevision: (revision.stdout || '').trim(), binaryClassification: sourceBuild ? 'locally-built-upstream-source' : 'official-upstream-release-binary', binaryPath: path.relative(workspace, exe).replaceAll('\\', '/'), binarySha256: crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex') },
    isolation: { HC_SESSION: session, home, XDG_STATE_HOME: env.XDG_STATE_HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME }, commands,
    observations: { startSucceeded: started?.exitCode === 0, statusSucceeded: status?.exitCode === 0, sameCorePid: Number.isInteger(parse(started)?.pid) && parse(started)?.pid === parse(status)?.pid,
      execReturnedFixtureOutput: exec?.exitCode === 0 && exec.stdout.includes('OMNIA_HERDR_EXEC_OK'), nonzeroExitPropagated: failure?.exitCode === 7,
      invalidTerminalNameRejected: invalidTerminal?.exitCode === 6 && invalidTerminal.stderr.includes('invalid_params'),
      ptyReturnedFixtureOutput: screen?.exitCode === 0 && screen.stdout.includes('OMNIA_HERDR_PTY_OK'),
      terminalMetadata: terminalInfo ? parse(terminalInfo) : null, stopExitCode: stop.exitCode, stoppedStatus: parse(stopped), coreStopped: stopped.exitCode !== 0 && stopped.stderr.includes('unavailable') },
    runtimeParity: 'unverified', conclusion: 'Observed isolated native core startup, real command execution and terminal probes. Provider integration, desktop-core interaction and full behavioral parity remain unverified.' };
  fs.writeFileSync(path.join(workspace, sourceBuild ? 'artifacts/upstream-ui/herdr-core-source-runtime-audit.json' : 'artifacts/upstream-ui/herdr-core-runtime-audit.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  const observed = report.observations;
  if (![observed.startSucceeded, observed.statusSucceeded, observed.sameCorePid, observed.execReturnedFixtureOutput, observed.nonzeroExitPropagated, observed.invalidTerminalNameRejected, observed.ptyReturnedFixtureOutput, observed.coreStopped].every(Boolean)) process.exitCode = 1;
}
