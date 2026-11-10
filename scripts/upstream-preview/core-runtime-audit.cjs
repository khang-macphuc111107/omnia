const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../upstream_extractions');
function hash(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
function checkTree(dir) {
  const files = [];
  function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory() && !['node_modules', 'resources', 'extensions'].includes(e.name)) walk(f); else if (e.isFile() && f.endsWith('.js')) files.push(f); } }
  walk(dir); let bad = 0; for (const f of files) { const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }); if (r.status !== 0) bad++; }
  return { javascriptFiles: files.length, syntaxFailures: bad };
}
const chrome = path.join(root, 'browser/chrome-canary');
const anti = path.join(root, 'ide/antigravity-core/app-unpacked');
const vscode = path.join(root, 'ide/vscode-core');
const build = spawnSync('npm.cmd', ['run', 'build', '--prefix', chrome], { encoding: 'utf8', timeout: 120000, windowsHide: true });
const antiTree = checkTree(path.join(anti, 'dist'));
const vscodeTree = checkTree(path.join(vscode, 'out'));
const antiMain = path.join(anti, 'dist/main.js');
const vscodeMain = path.join(vscode, 'out/main.js');
const chromeEntry = path.join(chrome, 'dist/index.js');
const chromeRun = spawnSync(process.execPath, [chromeEntry], { encoding: 'utf8', timeout: 10000 });
const antiRun = spawnSync(process.execPath, [antiMain], { encoding: 'utf8', timeout: 10000 });
const row = (name, dir, entry, run, syntax) => ({ name, packagePath: path.relative(root, path.join(dir, 'package.json')).replaceAll('\\', '/'), entry: { path: path.relative(root, entry).replaceAll('\\', '/'), bytes: fs.statSync(entry).size, sha256: hash(entry) }, syntax, directNodeRun: { exitCode: run.status, stdout: (run.stdout || '').slice(0, 500), stderr: (run.stderr || '').slice(0, 1000) }, runtimeParity: 'unverified' });
const report = { generatedAt: new Date().toISOString(), chromeBuild: { command: 'npm run build --prefix upstream_extractions/browser/chrome-canary', exitCode: build.status, error: build.error?.message, stdout: (build.stdout || '').slice(-1500), stderr: (build.stderr || '').slice(-1500), conclusion: build.status === 0 ? 'build passed' : 'build failed or could not be invoked; dependency/toolchain evidence retained' }, apps: [row('chrome-canary-cdp', chrome, chromeEntry, chromeRun, checkTree(path.join(chrome, 'dist'))), row('antigravity-core', anti, antiMain, antiRun, antiTree), row('vscode-core', vscode, vscodeMain, { status: null, stdout: '', stderr: 'Electron main not launched in this audit' }, vscodeTree)], notes: ['Antigravity main is an Electron entrypoint; direct Node execution fails because the electron module/runtime is not available.', 'Syntax and static artifact checks do not establish Electron, IPC, extension host, auth, backend, or UI behavioral parity.'] };
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../artifacts/upstream-ui/core-runtime-audit.json'); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
