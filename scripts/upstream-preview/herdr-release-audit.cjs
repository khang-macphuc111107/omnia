const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const workspace = path.resolve(__dirname, '../..');
const base = path.join(workspace, 'artifacts/upstream-ui/herdr-download');
const manifest = JSON.parse(fs.readFileSync(path.join(base, 'latest.json'), 'utf8').replace(/^\uFEFF/, ''));
const target = manifest.targets['windows-x86_64'];
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const archive = path.join(base, 'herdr-app-windows-x86_64.tar.gz');
const exe = path.join(base, 'herdr-app/herdr-app.exe');
if (hash(archive) !== target.sha256) throw new Error('Herdr archive integrity mismatch');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-herdr-cli-'));
const commands = [['--version'], ['--help'], ['commands'], ['--skill']].map((args) => {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, HERDR_APP_HOME: home } });
  const output = `${r.stdout || ''}\n${r.stderr || ''}`;
  const name = args[0].replace(/^--/, '');
  const log = path.join(workspace, `artifacts/upstream-ui/herdr-release-${name}.log`);
  fs.writeFileSync(log, output);
  return { args, exitCode: r.status, error: r.error?.message || null, bytes: Buffer.byteLength(output), sha256: hash(log), log: path.relative(workspace, log).replaceAll('\\', '/') };
});
const coreManifestFile = path.join(base, 'core-latest.json');
let core = null;
if (fs.existsSync(coreManifestFile)) {
  const manifest = JSON.parse(fs.readFileSync(coreManifestFile, 'utf8').replace(/^\uFEFF/, ''));
  const target = manifest.targets['windows-x86_64'];
  const archive = path.join(base, 'herdr-core-windows-x86_64.zip');
  const exe = path.join(base, 'herdr-core.exe');
  if (hash(archive) !== target.sha256) throw new Error('Herdr core archive integrity mismatch');
  const commands = [['--version'], ['--help']].map((args) => {
    const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const log = path.join(workspace, `artifacts/upstream-ui/herdr-core-${args[0].slice(2)}.log`);
    fs.writeFileSync(log, `${r.stdout || ''}\n${r.stderr || ''}`);
    return { args, exitCode: r.status, error: r.error?.message || null, log: path.relative(workspace, log).replaceAll('\\', '/'), sha256: hash(log) };
  });
  core = { manifest: 'https://releases.herdr.dev/core/latest.json', version: manifest.version, archiveUrl: target.url, expectedSha256: target.sha256, actualSha256: hash(archive), binarySha256: hash(exe), binaryBytes: fs.statSync(exe).size, commands };
}
const report = { generatedAt: new Date().toISOString(), provenance: { manifest: 'https://releases.herdr.dev/app/latest.json', version: manifest.version, target: 'windows-x86_64', archiveUrl: target.url, expectedSha256: target.sha256, actualSha256: hash(archive), integrityMatches: true },
  binary: { path: path.relative(workspace, exe).replaceAll('\\', '/'), bytes: fs.statSync(exe).size, sha256: hash(exe) }, commands, core,
  isolation: { HERDR_APP_HOME: home }, sourceClassification: 'official-upstream-release-binary', runtimeParity: 'unverified',
  conclusion: 'Official Windows desktop binary downloaded and verified against the publisher manifest. Version/help/command catalog/skill invocations are recorded individually; desktop GUI, core connectivity, terminals and full behavioral parity remain unverified.' };
fs.writeFileSync(path.join(workspace, 'artifacts/upstream-ui/herdr-release-audit.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
