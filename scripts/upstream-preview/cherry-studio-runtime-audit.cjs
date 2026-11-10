const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const workspace = path.resolve(__dirname, '../..');
const root = path.join(workspace, 'upstream_extractions/desktop-apps/cherry-studio');
const evidence = path.join(workspace, 'artifacts/upstream-ui');
const read = name => { const p = path.join(evidence, name); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
const artifact = p => ({ path: path.relative(workspace, p).replaceAll('\\', '/'), bytes: fs.statSync(p).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') });
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const launch = read('cherry-native-launch-audit.json');
const ui = read('cherry-native-isolated-ui-observations.json');
const phases = ui?.observations ?? [];
const hasPhase = (phase, expectedText) => phases.some(row => row.phase === phase && (row.accessibility?.document_text || row.accessibility?.tree || '').includes(expectedText));
const report = {
  generatedAt: new Date().toISOString(),
  provenance: { repository: pkg.homepage, version: pkg.version, packageManager: pkg.packageManager, main: pkg.main, revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), workingTreeStatus: spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim() },
  artifacts: { main: artifact(path.join(root, pkg.main)), preload: artifact(path.join(root, 'out/preload/preload.js')), rendererEntry: artifact(path.join(root, 'out/renderer/windows/main/index.html')) },
  historicalWrapperAttempt: read('cherry-studio-wrapper-attempt.json')?.launch ?? null,
  nativeLaunch: launch,
  recoveryEvidence: read('cherry-native-recovery-result.json'),
  prerequisitesEvidence: 'artifacts/upstream-ui/cherry-native-prerequisites-audit.json',
  ui: { evidence: 'artifacts/upstream-ui/cherry-native-isolated-ui-observations.json', observedAt: ui?.generatedAt, mainObserved: hasPhase('main-loaded', 'What should we work on today?'), chatObserved: hasPhase('chat-loaded', 'What should we talk about today?'), settingsObserved: hasPhase('settings-loaded', 'Settings'), dependenciesObserved: hasPhase('dependencies-loaded', 'bundled') },
  databaseObservation: read('cherry-native-database-observation.json'),
  externalExportRecovery: read('cherry-native-export-recovery.json'),
  sourceClassification: 'upstream-source-repository-with-built-artifacts',
  runtimeParity: 'unverified',
  conclusion: 'Native Electron launch and real upstream Work/Chat/Settings/Dependencies UI were observed after rebuilding missing SQLite and registry bindings and restoring checksum-pinned bundled tools. A scratch SQLite database was read. Complete IPC, persistence, speech, provider execution and behavioral parity remain unverified. Native payloads remain local and are not included by the Git evidence commit.'
};
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(evidence, 'cherry-studio-runtime-audit.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ui: report.ui, runtimeParity: report.runtimeParity, out }));
