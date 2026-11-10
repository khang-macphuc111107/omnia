// Validate the clean-room IDM import assembled outside the repository.
// The reference PE/binary files are evidence only; this script never loads or
// modifies them and does not extract credentials or defeat DRM/anti-bot logic.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const importRoot = path.resolve(process.env.OMNIA_IDM_IMPORT || 'C:/Users/khang/Documents/ChatGPT/Google Drive Downloader/idm_omnia_import');
const out = path.join(root, 'artifacts/upstream-ui/idm-omnia-import-provenance.json');
const report = { generatedAt: new Date().toISOString(), importRoot, classification: 'clean-room-compatible-import-with-reference-evidence', checks: {}, scope: ['segmented HTTP downloader', 'parser/category/history/export/import/scheduler/rate limiter', 'native protocol framing and WebSocket bridge', 'GUI/reference resources'], exclusions: ['credential extraction', 'DRM bypass', 'anti-bot evasion', 'privilege escalation', 'claim of proprietary IDM source recovery'] };
const save = () => { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); };
try {
  const required = ['README.md', 'manifest.json', 'index.js', 'idm-rust-audit.json', 'Cargo.toml', 'Cargo.lock', 'ARCHITECTURE_AND_ALGORITHMS.md'];
  report.required = required.map(name => ({ name, present: fs.existsSync(path.join(importRoot, name)) }));
  report.checks.requiredFiles = report.required.every(x => x.present);
  const manifest = JSON.parse(fs.readFileSync(path.join(importRoot, 'manifest.json'), 'utf8'));
  const manifestFiles = manifest.files || (Array.isArray(manifest) ? manifest : []);
  report.manifest = { entries: manifestFiles.length, declaredFileCount: manifest.fileCount, declaredTotalBytes: manifest.totalBytes };
  report.checks.manifestCount = manifestFiles.length === manifest.fileCount;
  let hashMismatch = 0;
  for (const item of manifestFiles) {
    const file = path.join(importRoot, item.path);
    if (!fs.existsSync(file)) { hashMismatch++; continue; }
    const bytes = fs.statSync(file).size;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (bytes !== item.bytes || hash !== item.sha256) hashMismatch++;
  }
  report.manifest.hashMismatch = hashMismatch;
  report.checks.manifestHashes = hashMismatch === 0;
  const entry = require(path.join(importRoot, 'index.js'));
  report.entrypoint = { exports: Object.keys(entry).length, names: Object.keys(entry).sort() };
  report.checks.entrypointLoads = Object.keys(entry).length > 0;
  report.runtimeApi = Object.fromEntries(Object.entries(entry).map(([name, value]) => {
    if (typeof value === 'function') return [name, { kind: 'class-or-function', methods: Object.getOwnPropertyNames(value.prototype || {}).filter(x => x !== 'constructor'), staticMethods: Object.getOwnPropertyNames(value).filter(x => !['length', 'name', 'prototype'].includes(x)) }];
    return [name, { kind: typeof value, keys: value && typeof value === 'object' ? Object.keys(value).slice(0, 64) : [] }];
  }));
  report.checks.javascriptSyntax = spawnSync(process.execPath, ['--check', path.join(importRoot, 'idm_core_js/index.js')], { encoding: 'utf8' }).status === 0;
  const jsDir = path.join(importRoot, 'idm_core_js');
  report.modules = fs.readdirSync(jsDir).filter(x => x.endsWith('.js')).map(name => ({ name, bytes: fs.statSync(path.join(jsDir, name)).size }));
  report.moduleAnalysis = report.modules.map(({ name, bytes }) => {
    const source = fs.readFileSync(path.join(jsDir, name), 'utf8');
    const functions = [...source.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]);
    const classes = [...source.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]);
    const states = [...source.matchAll(/\b(?:status|state|phase|STATE|STATUS)\s*[:=]\s*["'`]([^"'`]+)["'`]/g)].map(m => m[1]);
    return { name, bytes, functions, classes, stateLiterals: [...new Set(states)] };
  });
  const cargo = fs.readFileSync(path.join(importRoot, 'Cargo.toml'), 'utf8');
  report.dependencies = { rust: cargo.split(/\r?\n/).filter(line => /^(tokio|reqwest|futures-util|parking_lot|thiserror|bytes|serde|serde_json)\s*=/.test(line)).map(line => line.trim()) };
  const audit = JSON.parse(fs.readFileSync(path.join(importRoot, 'idm-rust-audit.json'), 'utf8'));
  report.rustAudit = audit;
  report.importedRustEvidence = { evidenceKind: 'imported-report-not-reexecuted', sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(importRoot, 'idm-rust-audit.json'))).digest('hex'), claimsSuccessfulCommands: audit.commands?.every(x => x.exitCode === 0) && audit.runtime?.selfTestPassed === true, limitation: 'Imported report claims are not fresh build/test verification. Use idm-rust-audit.cjs to execute against current repository source.' };
} catch (error) { report.error = error.stack || String(error); }
report.checks.all = !report.error && Object.values(report.checks).every(Boolean); save(); console.log(JSON.stringify(report, null, 2)); if (!report.checks.all) process.exitCode = 1;
