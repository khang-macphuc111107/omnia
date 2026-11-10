const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const workspace = path.resolve(__dirname, '../..');
const root = path.join(workspace, 'upstream_extractions/desktop-apps/herdr-app');
const outDir = path.join(workspace, 'artifacts/upstream-ui');
const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const artifact = (relative) => {
  const p = path.join(workspace, relative);
  return fs.existsSync(p) ? { path: relative, bytes: fs.statSync(p).size, sha256: hash(p) } : null;
};
const readReport = (name) => { const p = path.join(outDir, name); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
const native = readReport('herdr-native-build-result.json');
const source = readReport('herdr-desktop-source-core-audit.json');
const release = readReport('herdr-desktop-release-core-audit.json');
const coreNative = readReport('herdr-core-native-build-result.json');
const coreRuntime = readReport('herdr-core-source-runtime-audit.json');
const sourcePair = readReport('herdr-desktop-source-with-source-core-core-audit.json');
const report = {
  generatedAt: new Date().toISOString(),
  provenance: { repository: 'https://github.com/herdrdev/herdr-app.git', revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), version: '0.1.13', submodules: ['vendor/ghostty'] },
  desktop: { source: 'Rust native GPUI desktop app', manifest: 'Cargo.toml', entrypoint: 'src/main.rs', runtimeParity: 'unverified' },
  cli: { command: 'herdr-app', coreCommand: 'herdr-core (hc)', documentedCommands: ['status', 'ls', 'do', 'commands', '--skill', '--version'], runtimeParity: 'unverified' },
  build: { nativeEvidence: native, lock: artifact('upstream_extractions/desktop-apps/herdr-app/Cargo.lock'), tests: 'not-run-by-this-audit' },
  coreSource: { build: coreNative, runtimeEvidence: coreRuntime ? 'herdr-core-source-runtime-audit.json' : null, observations: coreRuntime?.observations ?? null },
  sourceDesktopWithSourceCore: sourcePair ? { evidence: 'herdr-desktop-source-with-source-core-core-audit.json', appControlResponded: sourcePair.appControlResponded, terminalFixture: sourcePair.desktopCreatedTerminalProducedFixture, coreStopped: sourcePair.coreStopped } : null,
  runtime: { source: source ? { evidence: 'herdr-desktop-source-core-audit.json', appControlResponded: source.appControlResponded, terminalFixture: source.desktopCreatedTerminalProducedFixture, binarySha256: source.binarySha256, coreStopped: source.coreStopped } : null,
    release: release ? { evidence: 'herdr-desktop-release-core-audit.json', appControlResponded: release.appControlResponded, terminalFixture: release.desktopCreatedTerminalProducedFixture, binarySha256: release.binarySha256, coreStopped: release.coreStopped } : null },
  conclusion: 'Source native build and isolated desktop/core command/terminal evidence are recorded separately from official release provenance. Complete UI, persistence, provider execution and behavioral parity remain unverified.'
};
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(outDir, 'herdr-audit.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
