const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../');
const apps = [
  ['chatgpt-web', 'chatgpt-web-adapter', 'ChatGptWebClient', 'list_conversations_uses_loopback_endpoint_and_auth_header', 'https://chatgpt.com', '/backend-api/conversations?offset=0&limit=28&order=updated', 'Authorization: Bearer'],
  ['claude-web', 'claude-web-adapter', 'ClaudeWebClient', 'organizations_uses_loopback_endpoint_cookie_and_user_agent', 'https://claude.ai', '/api/organizations', 'Cookie: sessionKey=']
];
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (args, cwd) => {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8', timeout: 120000, windowsHide: true });
  return { command: args.join(' '), cwd, exitCode: result.status, signal: result.signal, timedOut: result.error?.code === 'ETIMEDOUT', error: result.error?.message || null, stdout: (result.stdout || '').slice(-4000), stderr: (result.stderr || '').slice(-4000) };
};
const rows = apps.map(([dir, pkg, client, testName, baseUrl, endpoint, header]) => {
  const base = path.join(root, 'upstream_extractions', 'web-apis', dir);
  const files = ['Cargo.toml', 'Cargo.lock', 'SPEC_AND_ADAPTER.md', ...fs.readdirSync(path.join(base, 'src')).map((file) => `src/${file}`)];
  const test = run(['cargo', 'test', '--locked'], base);
  const clippy = run(['cargo', 'clippy', '--locked', '--all-targets', '--', '-D', 'warnings'], base);
  const build = run(['cargo', 'build', '--release', '--locked'], base);
  const passes = (test.stdout.match(/test result: ok/g) || []).length;
  return { app: dir, package: pkg, manifest: path.relative(root, path.join(base, 'Cargo.toml')), sourceFiles: files, sha256: Object.fromEntries(files.map((file) => [file, hash(path.join(base, file))])), api: { client, loopbackTest: testName, baseUrlDefault: baseUrl, endpoint, headerContract: header }, verification: { cargoTest: { ...test, passingResultMarkers: passes }, cargoClippyWarningsDenied: clippy, cargoBuildRelease: build }, runtimeParity: 'unverified', limitations: ['Loopback-only tests; no real provider request executed', 'Only one client operation implemented; streaming/SSE methods described in spec are not implemented', 'No packaged installer or upstream binary provenance verified'] };
});
const report = { generatedAt: new Date().toISOString(), evidenceKind: 'executed-rust-test-build', apps: rows, conclusion: 'Both adapters have fresh command output for test, clippy, and release build. Real ChatGPT/Claude provider parity, streaming, authentication provenance, and packaged runtime remain unverified.' };
const out = path.resolve(process.argv[2] || path.join(root, 'artifacts', 'upstream-ui', 'web-adapter-chatgpt-claude-audit.json'));
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
if (rows.some((row) => row.verification.cargoTest.exitCode !== 0 || row.verification.cargoClippyWarningsDenied.exitCode !== 0 || row.verification.cargoBuildRelease.exitCode !== 0)) process.exitCode = 1;
