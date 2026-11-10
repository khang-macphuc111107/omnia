const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../upstream_extractions/harnesses');
const names = fs.readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !['node_modules', 'dist', 'target'].includes(e.name))
  .map((e) => e.name).sort();

function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120000, windowsHide: true });
  return { command: [cmd, ...args].join(' '), exitCode: r.error ? null : r.status, error: r.error?.message, stdout: (r.stdout || '').slice(-2000), stderr: (r.stderr || '').slice(-2000) };
}

const apps = names.map((name) => {
  const dir = path.join(root, name);
  let pkg = {}; try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) { return { name, packageReadError: String(e), sourceClassification: 'directory-without-package-manifest', runtimeParity: 'unverified' }; }
  const reconstructed = /reconstructed|mock|stub|scaffolding|integration module/i.test(pkg.description || '');
  const dist = path.join(dir, 'dist', 'index.js');
  const row = { name, package: { name: pkg.name, version: pkg.version, description: pkg.description }, sourceClassification: reconstructed ? 'reconstructed-source-package' : 'upstream-source-package', build: null, entry: null, runtimeParity: 'unverified' };
  if (fs.existsSync(path.join(dir, 'tsconfig.json')) && reconstructed) {
    const tsc = path.resolve(__dirname, '../../node_modules/typescript/bin/tsc');
    row.build = run(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json'), '--pretty', 'false'], path.resolve(__dirname, '../..'));
  } else row.build = { command: 'tsc -p tsconfig.json', exitCode: null, error: reconstructed ? 'tsconfig.json missing' : 'skipped: upstream package requires its own workspace toolchain' };
  if (fs.existsSync(dist)) {
    const r = run(process.execPath, [dist], dir);
    row.entry = { path: 'dist/index.js', bytes: fs.statSync(dist).size, sha256: sha(dist), runExitCode: r.exitCode, output: (r.stdout || r.stderr || '').trim().slice(0, 500) };
  } else row.entry = { path: 'dist/index.js', missing: true };
  return row;
});
const report = { generatedAt: new Date().toISOString(), apps, notes: ['tsc uses the repository root toolchain when package-local dependencies are absent.', 'Initialization output and successful compilation do not establish provider, agent, IPC, auth, sandbox, or behavioral parity.'], conclusion: 'Harnesses with reconstructed descriptions are classified explicitly; the only non-reconstructed harness packages remain unverified until their own upstream runtime and backend behavior are exercised.' };
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../artifacts/upstream-ui/harness-runtime-audit.json');
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
