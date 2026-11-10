const fs = require('node:fs');
const path = require('node:path');
const catalog = require('./catalog.cjs');
const find = (root, names) => {
  const found = [];
  const walk = dir => {
    if (found.length >= 20) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && names.includes(entry.name)) found.push(full);
      else if (entry.isDirectory()) walk(full);
    }
  };
  walk(root); return found;
};
const rows = catalog.map(item => {
  const mainCandidates = find(item.root, ['main.js', 'main.cjs', 'preload.js', 'preload.cjs']);
  return { id: item.id, root: item.root, entry: item.entry, sourceClassification: item.sourceClassification, nearbyRuntimeCandidates: mainCandidates, runtimeParity: 'unverified' };
});
const report = { generatedAt: new Date().toISOString(), scope: 'Catalog asset roots and nearby runtime candidates; no launch or parity claim.', applications: rows };
if (process.argv[2]) { const output = path.resolve(process.argv[2]); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
for (const row of rows) console.log(`${row.id}: runtimeCandidates=${row.nearbyRuntimeCandidates.length} parity=${row.runtimeParity}`);
