const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../upstream_extractions');
const skip = new Set(['node_modules', '.git', 'build', 'dist', 'out', 'target']);
const packages = [];
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    const file = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(file);
    else if (ent.name === 'package.json') {
      try {
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
        const text = `${pkg.name || ''} ${pkg.description || ''}`.toLowerCase();
        if (/reconstructed|mock|stub|placeholder|shell/.test(text)) {
          packages.push({ path: path.relative(root, file), name: pkg.name, version: pkg.version, description: pkg.description, main: pkg.main, scripts: pkg.scripts });
        }
      } catch {}
    }
  }
}
walk(root);
const report = { generatedAt: new Date().toISOString(), root: 'upstream_extractions', reconstructedPackageCount: packages.length, packages, conclusion: 'Descriptions matching reconstructed/mock/stub/shell are provenance warnings. They are not treated as original upstream source or UI without independent artifact evidence.' };
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../artifacts/upstream-ui/reconstructed-wrapper-audit.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(`reconstructed-like packages: ${packages.length}`);
for (const p of packages) console.log(`${p.path}: ${p.description}`);
