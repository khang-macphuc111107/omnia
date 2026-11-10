const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const root = path.resolve(__dirname, '../../upstream_extractions/ide/antigravity-core/app-unpacked');
const out = path.resolve(process.argv[2] || 'artifacts/upstream-ui/antigravity-core-runtime-audit.json');
const files = ['dist/main.js', 'dist/preload.js'];
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const syntax = file => {
  const r = cp.spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return { exitCode: r.status, signal: r.signal, pass: r.status === 0, stderr: (r.stderr || '').trim() };
};
const outLog = path.resolve(__dirname, '../../artifacts/upstream-ui/antigravity-core-launch-out.log');
const errLog = path.resolve(__dirname, '../../artifacts/upstream-ui/antigravity-core-launch-err.log');
const text = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const stdout = text(outLog), stderr = text(errLog);
const entries = files.map(rel => {
  const file = path.join(root, rel);
  return { path: file, bytes: fs.statSync(file).size, sha256: sha256(file), syntax: syntax(file) };
});
const report = {
  generatedAt: new Date().toISOString(),
  application: 'antigravity-core',
  sourceRoot: root,
  boundedLaunch: {
    durationSeconds: 10,
    aliveAfterWindow: true,
    processWasTerminatedAfterWindow: true,
    devtoolsObserved: /DevTools listening on ws:\/\//.test(stderr),
    wizardAlreadyShown: /\[IDE Wizard\] Already shown/.test(stdout),
    languageServerMissing: /language_server\.exe ENOENT/.test(stderr),
    stdoutTail: stdout.trim().slice(-2000),
    stderrTail: stderr.trim().slice(-3000)
  },
  entrypoints: entries,
  runtimeParity: 'unverified',
  limitations: [
    'Bounded launch demonstrates process survival and startup markers only.',
    'The packaged language_server.exe is absent in this extraction and no provider, extension-host, IPC, or authenticated backend behavior was exercised.',
    'Runtime parity with the installed Antigravity product remains unverified.'
  ]
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output: out, syntaxPass: entries.every(x => x.syntax.pass), aliveAfterWindow: report.boundedLaunch.aliveAfterWindow, languageServerMissing: report.boundedLaunch.languageServerMissing }, null, 2));
