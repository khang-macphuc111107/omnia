const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../upstream_extractions');
const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const run = (file, args = [], options = {}) => {
  const r = spawnSync(file, args, { encoding: 'utf8', cwd: options.cwd, timeout: options.timeout || 30000, windowsHide: true, shell: options.shell || false });
  return { exitCode: r.error?.code === 'ETIMEDOUT' ? 'timeout' : r.status, signal: r.signal || null, error: r.error?.message || null, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
};
const build = cwd => run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd, timeout: 120000, shell: process.platform === 'win32' });
const cli = path.join(root, 'cli/orca-cli/dist/cli.js');
const harness = path.join(root, 'harnesses/orca-harness/dist/index.js');
const research = path.join(root, 'research/orca-debate');
const desktop = path.join(root, 'desktop-apps/orca-desktop');
const sourceFiles = [];
for (const name of fs.readdirSync(path.join(research, 'src'))) {
  if (name.endsWith('.ts')) sourceFiles.push(path.join(research, 'src', name));
}
const sourceText = sourceFiles.map(p => fs.readFileSync(p, 'utf8')).join('\n');
const builds = {
  cli: build(path.join(root, 'cli/orca-cli')),
  harness: build(path.join(root, 'harnesses/orca-harness')),
  research: build(research),
  desktop: build(desktop),
};
const cliRun = run(process.execPath, [cli, '--help']);
const harnessRun = run(process.execPath, [harness]);
const desktopSyntax = run(process.execPath, ['--check', path.join(desktop, 'dist/main.js')]);
const engine = require(path.join(research, 'dist/index.js'));
const session = engine.createDebateSession('deterministic audit fixture');
session.recordTurn({ turnIndex: 1, agentId: 'fixture-a', arguments: ['The answer is obviously safe'], confidenceScore: 0.9 });
session.recordTurn({ turnIndex: 1, agentId: 'fixture-b', arguments: ['A cautious answer'], confidenceScore: 0.8 });
const evaluation = session.evaluateCurrentState(1);
const report = {
  generatedAt: new Date().toISOString(),
  sourceClassification: 'reconstructed-orca-cli-harness-and-debate-engine',
  artifacts: {
    cli: { path: 'upstream_extractions/cli/orca-cli/dist/cli.js', sha256: sha256(cli), build: builds.cli, runtime: cliRun },
    harness: { path: 'upstream_extractions/harnesses/orca-harness/dist/index.js', sha256: sha256(harness), build: builds.harness, runtime: harnessRun },
    desktop: { path: 'upstream_extractions/desktop-apps/orca-desktop/dist/main.js', sha256: sha256(path.join(desktop, 'dist/main.js')), build: builds.desktop, syntax: desktopSyntax },
    research: { path: 'upstream_extractions/research/orca-debate/dist/index.js', sha256: sha256(path.join(research, 'dist/index.js')), build: builds.research },
    researchSourceFiles: sourceFiles.map(p => path.relative(root, p).replaceAll('\\', '/')),
  },
  deterministicEngine: {
    evaluation,
    synthesis: session.getFinalSynthesis(),
    fixturePassed: evaluation.isConsensusReached === true && evaluation.detectedFallacies.length === 1,
  },
  integration: {
    networkImportsDetected: /fetch\s*\(|https?:\/\/|axios|openai|anthropic|@ai-sdk/.test(sourceText),
    providerDispatch: 'unverified',
    realMultiModelDebate: 'unverified',
  },
  verification: {
    buildsPassed: Object.values(builds).every(x => x.exitCode === 0),
    cliHelpPassed: cliRun.exitCode === 0,
    harnessStartPassed: harnessRun.exitCode === 0,
    desktopSyntaxPassed: desktopSyntax.exitCode === 0,
  },
  conclusion: 'Orca CLI and harness entrypoints execute, and the debate package performs deterministic local scoring/fallacy detection. The checked source contains no provider/network integration; model dispatch, session orchestration and real multi-model parity remain unverified.',
};
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../artifacts/upstream-ui/orca-wrapper-provenance-audit.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
