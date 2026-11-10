const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../upstream_extractions/cli');
const workspace = path.resolve(__dirname, '../..');
const apps = ['agy-cli', 'claude-cli', 'codex-cli', 'hermes-cli', 'opencode-cli', 'orca-cli'];
function run(cwd, args, timeout = 120000) {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const actualArgs = process.platform === 'win32' ? ['/d','/s','/c', ['npm', ...args].join(' ')] : args;
  const r = spawnSync(command, actualArgs, { cwd, encoding: 'utf8', timeout, windowsHide: true });
  return { command: [command, ...args].join(' '), exitCode: r.error?.code === 'ETIMEDOUT' ? 'timeout' : (typeof r.status === 'number' ? r.status : null), error: r.error?.code || null, stdout: (r.stdout || '').slice(-3000), stderr: (r.stderr || '').slice(-3000) };
}
const rows = apps.map(app => {
  const cwd = path.join(root, app), pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')), entry = path.join(cwd, 'dist', 'cli.js');
  const build = run(cwd, ['run', 'build']);
  const help = spawnSync(process.execPath, [entry, '--help'], { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true });
  return { app, package: { name: pkg.name, version: pkg.version, description: pkg.description }, build,
    entry: { path: `cli/${app}/dist/cli.js`, present: fs.existsSync(entry), bytes: fs.existsSync(entry) ? fs.statSync(entry).size : 0, sha256: fs.existsSync(entry) ? crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex') : null,
      help: { command: 'node dist/cli.js --help', exitCode: typeof help.status === 'number' ? help.status : null, error: help.error?.code || null, stdout: (help.stdout || '').slice(-2000), stderr: (help.stderr || '').slice(-2000) } },
    sourceClassification: 'reconstructed-source-package', runtimeParity: 'unverified' };
});
const report = { generatedAt: new Date().toISOString(), evidenceKind: 'executed-cli-build-and-help-probe', apps: rows, conclusion: 'Build and help commands were executed for every extracted CLI package in scope. This verifies only local reconstructed entrypoints; provider authentication, native payloads, app-server IPC and upstream parity remain unverified.' };
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(workspace, 'artifacts/upstream-ui/remaining-cli-audit.json');
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ out, apps: rows.map(r => ({ app: r.app, build: r.build.exitCode, help: r.entry.help.exitCode })) }, null, 2));



