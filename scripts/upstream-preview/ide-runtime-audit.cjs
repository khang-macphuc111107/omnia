const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const catalog = require('./catalog.cjs').filter(item => ['cursor', 'windsurf', 'antigravity', 'agy-desktop'].includes(item.id));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rows = [];
for (const item of catalog) {
  const candidates = [];
  const walk = dir => { let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const e of entries) { if (e.name === 'node_modules') continue; const full = path.join(dir, e.name); if (e.isFile() && ['main.js', 'preload.js'].includes(e.name)) candidates.push(full); else if (e.isDirectory()) walk(full); } };
  walk(item.root);
  const files = candidates.map(file => { const syntax = require('node:child_process').spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }); return { file, bytes: fs.statSync(file).size, sha256: hash(file), syntaxPass: syntax.status === 0, stderr: syntax.stderr.trim() }; });
  rows.push({ id: item.id, sourceClassification: item.sourceClassification, files, runtimeParity: 'unverified' });
}
const report = { generatedAt: new Date().toISOString(), scope: 'Static IDE main/preload evidence; syntax and hashes do not prove Electron launch or IPC parity.', applications: rows };
if (process.argv[2]) { const output = path.resolve(process.argv[2]); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
for (const row of rows) console.log(`${row.id}: files=${row.files.length} syntaxPass=${row.files.filter(x => x.syntaxPass).length} parity=${row.runtimeParity}`);
