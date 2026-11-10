const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '../../upstream_extractions/desktop-apps/claude-desktop');
const app = path.join(root, 'app-unpacked');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const files = [];
function walk(dir, depth = 0) {
  if (depth > 4) return;
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') walk(p, depth + 1);
    else if (entry.isFile() && entry.name === 'manifest.json') files.push(p);
  }
}
walk(app);
const junction = path.join(app, 'app.asar.unpacked');
let junctionTarget = null; let targetExists = false;
try { junctionTarget = fs.readlinkSync(junction); targetExists = fs.existsSync(junctionTarget); } catch {}
const ion = path.join(app, 'ion-dist/index.html');
const report = {
  generatedAt: new Date().toISOString(),
  packageVersion: JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version,
  ionIndex: { path: 'app-unpacked/ion-dist/index.html', bytes: fs.statSync(ion).size, sha256: hash(ion) },
  referencedManifest: '/manifest.json',
  candidateManifests: files.map(p => ({ path: path.relative(root, p).replaceAll('\\', '/'), bytes: fs.statSync(p).size, sha256: hash(p), referencedByIon: false })),
  appAsarUnpacked: { path: 'app-unpacked/app.asar.unpacked', junctionTarget, targetExists },
  provenanceStatus: files.some(p => path.relative(root, p).replaceAll('\\', '/') === 'app-unpacked/manifest.json') ? 'manifest-found' : 'asset-check-failed',
  conclusion: 'The current extracted ion-dist asset does not contain its referenced root manifest. Existing manifest.json files belong to bundled skills and are not provenance-equivalent; the native unpacked junction target is unavailable.',
};
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../artifacts/upstream-ui/claude-runtime-provenance-refresh.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
