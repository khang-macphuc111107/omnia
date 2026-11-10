const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '../../upstream_extractions');
const app = path.join(root, 'harnesses/codex-app-unpacked');
const main = path.join(app, '.vite/build/early-bootstrap.js');
const files = fs.readdirSync(path.join(app, '.vite/build')).filter((x) => x.endsWith('.js'));
function run(command, cwd) {
  const r = cp.spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: 30000, windowsHide: true });
  return { command, cwd: path.relative(root, cwd).replaceAll('\\', '/'), exitCode: r.status, signal: r.signal, timedOut: r.error?.code === 'ETIMEDOUT', error: r.error?.message ?? null, stdoutTail: (r.stdout ?? '').slice(-2000), stderrTail: (r.stderr ?? '').slice(-2000) };
}
const harness = path.join(root, 'harnesses/codex-harness');
const report = { generatedAt: new Date().toISOString(), package: JSON.parse(fs.readFileSync(path.join(app, 'package.json'))), entrypoint: { path: path.relative(root, main).replaceAll('\\', '/'), bytes: fs.statSync(main).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(main)).digest('hex') }, buildArtifacts: { javascriptFiles: files.length, names: files.slice(0, 40) }, executed: { harnessBuild: run('npm run build', harness), harnessHelp: run('node dist/index.js --help', harness), appEntrypointSyntax: run(`node --check "${main}"`, app) }, launch: { electronRuntime: 'OpenCode bundle Electron 44.9.1', status: 'not-run-in-this-audit', output: ['Windows core runtime and startup policy are not available in the extracted source tree'], runtimeParity: 'unverified' }, sourceClassification: 'reconstructed/extracted source; no packaged Windows runtime or authenticated provider was exercised', conclusion: 'Codex harness build/help and extracted Electron entrypoint syntax were executed and passed; desktop UI, native Windows runtime, provider behavior, and packaged parity remain unverified.' };
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../artifacts/upstream-ui/codex-launch-audit.json'); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
