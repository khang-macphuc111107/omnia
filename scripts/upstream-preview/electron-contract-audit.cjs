const fs = require('node:fs');
const path = require('node:path');
const base = path.resolve(__dirname, '../../upstream_extractions/desktop-apps');
const rows = [];
for (const dir of fs.readdirSync(base, { withFileTypes: true }).filter(x => x.isDirectory())) {
  const root = path.join(base, dir.name), packagePath = path.join(root, 'package.json');
  if (!fs.existsSync(packagePath)) continue;
  let pkg; try { pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')); } catch { continue; }
  const main = typeof pkg.main === 'string' ? path.resolve(root, pkg.main) : null;
  let source = '', sourceRead = false;
  if (main && fs.existsSync(main) && fs.statSync(main).isFile() && fs.statSync(main).size < 20_000_000) {
    source = fs.readFileSync(main, 'utf8'); sourceRead = true;
  }
  const preloadRefs = [...source.matchAll(/preload(?:Script|Path)?|preload\.js|contextBridge|ipcMain|ipcRenderer/gi)].map(m => m[0]);
  rows.push({ app: dir.name, main, mainExists: Boolean(main && fs.existsSync(main)), sourceRead, electronImport: /(?:require\(['"]electron['"]\)|from ['"]electron['"])/.test(source), preloadOrIpcReferences: [...new Set(preloadRefs)], runtimeParity: 'unverified' });
}
const report = { generatedAt: new Date().toISOString(), scope: 'Static Electron main contract evidence only; no app launch or IPC parity claim.', applications: rows };
if (process.argv[2]) { const out = path.resolve(process.argv[2]); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); }
for (const row of rows) console.log(`${row.app}: electronImport=${row.electronImport} preloadOrIpc=${row.preloadOrIpcReferences.length} parity=${row.runtimeParity}`);
