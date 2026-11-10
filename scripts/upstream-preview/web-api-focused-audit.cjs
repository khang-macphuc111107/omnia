const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../upstream_extractions/web-apis');
const apps = ['chatgpt-web', 'claude-web', 'gemini-notebook-web', 'gemini-web'];
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (args, cwd) => {
  const r = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8', timeout: 120000, windowsHide: true });
  return { command: args.join(' '), exitCode: r.status, signal: r.signal, timedOut: r.error?.code === 'ETIMEDOUT', error: r.error?.message || null, stdout: (r.stdout || '').slice(-4000), stderr: (r.stderr || '').slice(-4000) };
};
const rows = apps.map((app) => {
  const cwd = path.join(root, app);
  const test = run(['cargo', 'test', '--locked'], cwd);
  const build = run(['cargo', 'build', '--release', '--locked'], cwd);
  const testPasses = (test.stdout.match(/test result: ok/g) || []).length;
  // These crates expose a Rust library, not a standalone executable. Prefer a
  // real library payload when Cargo emitted one; keep dependency metadata out
  // of the artifact field so the report cannot imply a runnable binary.
  const releaseDir = path.join(cwd, 'target', 'release');
  const library = fs.readdirSync(releaseDir, { withFileTypes: true }).find((e) => e.isFile() && /^lib.*adapter\.(rlib|dll|lib|rmeta)$/.test(e.name));
  const libraryPath = library ? path.join(releaseDir, library.name) : null;
  const lock = path.join(cwd, 'Cargo.lock');
  return { app, manifest: `upstream_extractions/web-apis/${app}/Cargo.toml`, lockSha256: hash(lock), test: { ...test, passingResultMarkers: testPasses }, releaseBuild: { ...build, artifactKind: 'library crate (no standalone executable)', artifact: libraryPath ? { path: `upstream_extractions/web-apis/${app}/target/release/${library.name}`, bytes: fs.statSync(libraryPath).size, sha256: hash(libraryPath) } : null }, providerBehavior: 'unverified', runtimeParity: 'unverified' };
});
const report = { generatedAt: new Date().toISOString(), evidenceKind: 'executed-rust-test-build', apps: rows, conclusion: 'ChatGPT Web, Claude Web, Gemini Notebook Web, and Gemini Web adapters were tested and release-built locally. Their loopback unit tests exercise request construction only; authenticated provider/session/API parity remains unverified.' };
const out = path.resolve(process.argv[2] || path.join(__dirname, '../../artifacts/upstream-ui/web-api-focused-audit.json'));
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
if (rows.some((r) => r.test.exitCode !== 0 || r.releaseBuild.exitCode !== 0)) process.exitCode = 1;


