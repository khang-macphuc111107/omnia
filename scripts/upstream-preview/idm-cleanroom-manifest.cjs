const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../artifacts/idm-cleanroom-20261106');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(dir, entry.name);
  // Build outputs are reproducible products, not clean-room source inputs.
  if (entry.isDirectory() && (entry.name === 'target' || entry.name === '.git')) return [];
  return entry.isDirectory() ? walk(file) : [file];
});
const base = path.resolve(root);
const manifestPath = path.join(root, 'manifest.json');
let generatedAt = new Date().toISOString();
try {
  const previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (typeof previous.generatedAt === 'string' && previous.generatedAt) generatedAt = previous.generatedAt;
} catch {}
const files = walk(root).filter(file => path.basename(file) !== 'manifest.json').map(file => ({
  path: path.relative(base, file).replaceAll('\\', '/'),
  bytes: fs.statSync(file).size,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}));
const manifest = {
  schemaVersion: 1,
  generatedAt,
  source: 'upstream_extractions/downloaders/idm-multistream',
  classification: 'clean-room-reconstructed-source',
  fileCount: files.length,
  files,
  entrypoint: 'entrypoint.cmd',
  evidenceBoundary: 'Included Rust source behavior is verified by repository loopback tests; installed IDM Win32/native/extension parity is unverified.'
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ root, fileCount: files.length, manifest: manifestPath, generatedAt }, null, 2));
