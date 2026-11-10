const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ws = path.resolve(__dirname, '../..');
const base = path.join(ws, 'upstream_extractions', 'harnesses');
const names = ['agy-harness', 'claude-harness', 'codex-harness', 'deepseek-harness', 'droid-harness', 'hermes-harness', 'opencode-harness', 'orca-harness', 'pi-harness'];
function run(cwd, exe, args, timeout = 30000) {
  const r = spawnSync(exe, args, { cwd, encoding: 'utf8', timeout, windowsHide: true });
  return { command: [exe, ...args].join(' '), exitCode: typeof r.status === 'number' ? r.status : null, timedOut: r.error?.code === 'ETIMEDOUT', error: r.error?.code || null, stdout: (r.stdout || '').slice(-2000), stderr: (r.stderr || '').slice(-2000) };
}
const rows = names.map(name => {
  const dir = path.join(base, name);
  const entry = path.join(dir, 'dist', 'index.js');
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const build = run(dir, 'npm.cmd', ['run', 'build']);
  const help = run(dir, process.execPath, ['dist/index.js', '--help'], 10000);
  return { name, version: pkg.version, package: pkg.name, nodeModulesPresent: fs.existsSync(path.join(dir, 'node_modules')), entry: { present: fs.existsSync(entry), sha256: fs.existsSync(entry) ? crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex') : null }, build, help, initialized: help.exitCode === 0 && /initialized/i.test(help.stdout), sourceClassification: 'reconstructed-source-package', runtimeParity: 'unverified' };
});
const report = { generatedAt: new Date().toISOString(), evidenceKind: 'executed-bounded-harness-probes', apps: rows, summary: { total: rows.length, buildPass: rows.filter(r => r.build.exitCode === 0).length, helpPass: rows.filter(r => r.help.exitCode === 0).length, initialized: rows.filter(r => r.initialized).length }, conclusion: 'These bounded build and --help probes establish local reconstructed harness startup only. They do not establish upstream provenance, provider/session behavior, native integration, or product parity.' };
const out = path.resolve(process.argv[2] || path.join(ws, 'artifacts/upstream-ui/harness-gap-runtime-audit.json'));
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
if (rows.some(r => r.build.exitCode !== 0 || r.help.exitCode !== 0 || !r.initialized)) process.exitCode = 1;
