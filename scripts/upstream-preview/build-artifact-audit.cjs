const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../upstream_extractions/desktop-apps/cherry-studio');
const files = ['out/main/main.js', 'out/renderer/windows/main/index.html'];
const preloadDir = path.join(root, 'out/preload');
const syntax = [];
for (const file of [path.join(root, 'out/main/main.js'), ...fs.existsSync(preloadDir) ? fs.readdirSync(preloadDir).filter(name => name.endsWith('.js')).map(name => path.join(preloadDir, name)) : []]) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  syntax.push({ file, passed: result.status === 0, stderr: result.stderr.trim() });
}
const report = {
  generatedAt: new Date().toISOString(),
  app: 'cherry-studio',
  buildFiles: files.map(file => ({ file, exists: fs.existsSync(path.join(root, file)), bytes: fs.existsSync(path.join(root, file)) ? fs.statSync(path.join(root, file)).size : 0 })),
  preloadFiles: fs.existsSync(preloadDir) ? fs.readdirSync(preloadDir).filter(name => name.endsWith('.js')) : [],
  syntax,
  runtimeParity: 'unverified',
  conclusion: 'Build artifact presence and Node syntax do not prove Electron launch, IPC, native modules, auth or backend behavior.',
};
if (process.argv[2]) { const output = path.resolve(process.argv[2]); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
for (const item of syntax) console.log(`${path.basename(item.file)}: syntax=${item.passed ? 'pass' : 'fail'}`);
