const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../upstream_extractions/downloaders/idm-multistream');
const binary = path.join(root, 'target/release/idm-download.exe');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(SystemRoot|WINDIR|TEMP|TMP|PATH|PATHEXT|COMSPEC|SYSTEMDRIVE|USERPROFILE|CARGO_HOME|RUSTUP_HOME)$/i.test(key)));
const sourceFingerprint = ['Cargo.toml', 'Cargo.lock', ...fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.rs')).map(name => `src/${name}`)]
  .map(file => ({ path: file, sha256: sha256(path.join(root, file)) }));
const commands = [['test', '--locked'], ['build', '--release', '--locked'], ['clippy', '--locked', '--all-targets', '--', '-D', 'warnings']].map(args => {
  const startedAt = new Date().toISOString();
  const result = spawnSync('cargo', args, { cwd: root, env, encoding: 'utf8', timeout: 180000, windowsHide: true });
  return { command: ['cargo', ...args].join(' '), cwd: root, startedAt,
    endedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal,
    error: result.error?.message ?? null, stdout: result.stdout, stderr: result.stderr };
});
const run = args => {
  try {
    const stdout = execFileSync(binary, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
    return { exitCode: 0, stdout };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};
const help = fs.existsSync(binary) ? run(['--help']) : { exitCode: null, stdout: '' };
const selfTest = fs.existsSync(binary) ? run(['--test']) : { exitCode: null, stdout: '' };
const report = {
  generatedAt: new Date().toISOString(),
  app: 'idm-multistream-rust',
  manifest: 'upstream_extractions/downloaders/idm-multistream/Cargo.toml',
  evidenceKind: 'executed-build-test-cli',
  sourceFingerprint,
  commands,
  releaseBinary: { path: 'target/release/idm-download.exe', present: fs.existsSync(binary), bytes: fs.existsSync(binary) ? fs.statSync(binary).size : 0, sha256: fs.existsSync(binary) ? sha256(binary) : null },
  runtime: {
    helpExitCode: help.exitCode,
    helpUsagePresent: help.stdout.includes('idm-download <URL> [OPTIONS]'),
    selfTestExitCode: selfTest.exitCode,
    selfTestPassed: selfTest.stdout.includes('[Self-Test] All core range algorithms verified 100% PASS.'),
  },
  runtimeParity: 'unverified',
  conclusion: 'Command outputs below record this run. CLI self-test text alone does not assert algorithm correctness. Proprietary IDM Win32 GUI, native host and protocol parity remain unverified.'
};
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../artifacts/upstream-ui/idm-rust-audit.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (commands.some(command => command.exitCode !== 0) || help.exitCode !== 0 || selfTest.exitCode !== 0) process.exitCode = 1;
