const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../upstream_extractions/harnesses/opencode');
const rel = (p) => path.relative(path.resolve(__dirname, '../..'), p).replaceAll('\\', '/');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const exists = (p) => fs.existsSync(p);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const localBun = path.resolve(__dirname, '../../.toolchains/bun-1.4.4/package/bin/bun.exe');
const bunExecutable = process.env.OMNIA_BUN || (exists(localBun) ? localBun : 'bun');
const bun = spawnSync(bunExecutable, ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true });
const bunAvailable = bun.status === 0;
const verify = process.argv.includes('--verify');
const commands = [
  ['server-typecheck', 'packages/server', ['run', 'typecheck']],
  ['server-build', 'packages/server', ['run', 'build']],
  ['cli-help', 'packages/cli', ['run', 'src/index.ts', '--help']],
];
const results = commands.map(([name, cwd, args]) => {
  if (!verify || !bunAvailable) return { name, cwd, args, status: 'not-executed' };
  const result = spawnSync(bunExecutable, args, { cwd: path.join(root, cwd), encoding: 'utf8', windowsHide: true, env: { ...process.env, PATH: path.dirname(bunExecutable) + path.delimiter + process.env.PATH }, maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const log = path.resolve(__dirname, `../../artifacts/upstream-ui/opencode-${name}.log`);
  fs.writeFileSync(log, output);
  return { name, cwd, args, exitCode: result.status, signal: result.signal, error: result.error?.message || null, status: result.status === 0 ? 'passed' : 'failed', log: rel(log), logSha256: sha256(log), outputTail: output.slice(-3500) };
});
const candidates = [
  ['desktop', 'packages/desktop/package.json'],
  ['cli', 'packages/cli/package.json'],
  ['server', 'packages/server/package.json'],
  ['app', 'packages/app/package.json'],
];
const packages = candidates.map(([name, file]) => {
  const absolute = path.join(root, file);
  if (!exists(absolute)) return { name, path: rel(absolute), present: false };
  const child = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  return {
    name,
    path: rel(absolute),
    present: true,
    packageName: child.name,
    version: child.version,
    scripts: child.scripts || {},
    sourceDirectories: ['src', 'electron', 'dist'].filter((d) => exists(path.join(path.dirname(absolute), d))),
  };
});
const lock = path.join(root, 'bun.lock');
const report = {
  generatedAt: new Date().toISOString(),
  provenance: {
    repository: pkg.repository,
    package: pkg.name,
    version: pkg.version,
    packageManager: pkg.packageManager,
    revision: (() => { const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }); return (r.stdout || '').trim() || null; })(),
  },
  packages,
  lockfile: { path: rel(lock), present: exists(lock), bytes: exists(lock) ? fs.statSync(lock).size : 0, sha256: exists(lock) ? sha256(lock) : null },
  toolchain: {
    executable: rel(bunExecutable),
    executableSha256: exists(bunExecutable) ? sha256(bunExecutable) : null,
    bun: { available: bunAvailable, version: bunAvailable ? bun.stdout.trim() : null, error: bun.error?.message || (bun.stderr || '').trim() || null },
    commandResults: results,
  },
  sourceClassification: 'upstream-source-repository',
  runtimeParity: 'unverified',
  conclusion: bunAvailable
    ? 'Bun is available. Command results record actual focused verification when --verify is supplied; desktop, authenticated backend and behavioral parity remain unverified.'
    : 'OpenCode upstream source, desktop, CLI and server package manifests are present, but Bun is unavailable on this host; build, backend and desktop runtime were not claimed.',
};
const outputArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const out = outputArg ? path.resolve(outputArg) : path.resolve(__dirname, '../../artifacts/upstream-ui/opencode-runtime-audit.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
