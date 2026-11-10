#!/usr/bin/env node
'use strict';

// Copy only the clean-room release payload into an explicitly selected import
// directory. Existing reference evidence in the destination is preserved.
// The destination must be supplied explicitly to avoid accidental broad copies.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const source = path.resolve(__dirname, '../../artifacts/idm-cleanroom-20261106');
const destination = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('usage: node scripts/upstream-preview/idm-import-sync.cjs <destination>');
  process.exit(2);
}
if (!fs.existsSync(path.join(source, 'manifest.json'))) throw new Error(`missing source manifest: ${source}`);
fs.mkdirSync(destination, { recursive: true });
const sourceManifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
const files = sourceManifest.files;
for (const item of files) {
  const relative = item.path.replaceAll('/', path.sep);
  const from = path.join(source, relative);
  const to = path.join(destination, relative);
  if (!fs.existsSync(from)) throw new Error(`manifest file missing: ${item.path}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceManifestHash = hash(path.join(source, 'manifest.json'));
const imported = files.map(item => {
  const file = path.join(destination, item.path.replaceAll('/', path.sep));
  const stat = fs.statSync(file);
  const sha256 = hash(file);
  if (stat.size !== item.bytes || sha256 !== item.sha256) throw new Error(`post-copy checksum mismatch: ${item.path}`);
  return { path: item.path, bytes: stat.size, sha256 };
});
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourcePackage: 'artifacts/idm-cleanroom-20261106',
  sourceManifestSha256: sourceManifestHash,
  classification: 'clean-room-reconstructed-source',
  fileCount: imported.length,
  files: imported,
  preservedDestinationContent: true,
  proprietaryBinaryIncluded: false,
  evidence: [
    'artifacts/upstream-ui/idm-rust-executed-audit.json',
    'artifacts/upstream-ui/idm-loopback-download-audit.json',
    'artifacts/upstream-ui/idm-loopback-failure-audit.json',
    'artifacts/upstream-ui/idm-interrupted-resume-audit.json'
  ],
  parityBoundary: 'Rust clean-room behavior is verified by loopback tests; installed IDM Win32/native/extension parity is unverified.'
};
fs.writeFileSync(path.join(destination, 'cleanroom-import-manifest.json'), JSON.stringify(report, null, 2) + '\n');
const readme = [
  '# Omnia IDM clean-room import',
  '',
  `Generated from ${report.sourcePackage} with ${report.fileCount} checksummed files.`,
  '',
  'The sync is allowlisted and preserves existing reference evidence in this directory.',
  'It includes no proprietary IDM binary, credentials, DRM bypass, or native parity claim.',
  'Rust behavior is covered by the repository loopback and interrupted-resume evidence listed in cleanroom-import-manifest.json.',
  ''
].join('\\n');
fs.writeFileSync(path.join(destination, 'CLEANROOM_IMPORT.md'), readme);
console.log(JSON.stringify({ destination, fileCount: imported.length, sourceManifestSha256: sourceManifestHash }, null, 2));
