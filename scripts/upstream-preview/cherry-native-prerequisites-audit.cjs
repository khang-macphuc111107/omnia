const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const workspace = path.resolve(__dirname, '../..');
const root = path.join(workspace, 'upstream_extractions/desktop-apps/cherry-studio');
const upstreamDownloader = path.join(root, 'scripts/download-binaries.js');
const { TOOLS, verifyBundledBinaries } = require(upstreamDownloader);
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const artifact = p => fs.existsSync(p) ? { path: path.relative(workspace, p).replaceAll('\\', '/'), bytes: fs.statSync(p).size, sha256: hash(p) } : null;
const report = { generatedAt: new Date().toISOString(), downloader: artifact(upstreamDownloader), upstreamBundleCheck: null, tools: [], nativeBindings: [], runtimeParity: 'unverified' };
try { verifyBundledBinaries('win32', 'x64'); report.upstreamBundleCheck = { passed: true }; }
catch (e) { report.upstreamBundleCheck = { passed: false, error: e.message }; }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-cherry-tools-'));
for (const tool of TOOLS) {
  const pkg = tool.packages['win32-x64'];
  if (!pkg) continue;
  const bundle = path.join(root, 'resources/binaries/win32-x64');
  const marker = path.join(bundle, tool.versionFile);
  const binary = path.join(bundle, pkg.binaries[0]);
  const row = { name: tool.name, declaredVersion: tool.version, archive: { url: pkg.url, upstreamExpectedSha256: pkg.sha256 }, marker: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null, binaries: pkg.binaries.map(p => artifact(path.join(bundle, p))) };
  if (process.argv.includes('--verify') && fs.existsSync(binary)) {
    const result = spawnSync(binary, ['--version'], { cwd: scratch, env: { ...process.env, MISE_DATA_DIR: path.join(scratch, 'mise-data'), MISE_CACHE_DIR: path.join(scratch, 'mise-cache'), MISE_CONFIG_DIR: path.join(scratch, 'mise-config') }, encoding: 'utf8', timeout: 15000, windowsHide: true });
    row.versionProbe = { args: ['--version'], exitCode: result.status, error: result.error?.message || null, stdout: result.stdout || '', stderr: result.stderr || '' };
  }
  report.tools.push(row);
}
for (const [name, relative] of [['better-sqlite3', 'better-sqlite3/build/Release/better_sqlite3.node'], ['registry-js', 'registry-js/build/Release/registry.node']]) {
  report.nativeBindings.push({ name, artifact: artifact(path.join(root, 'node_modules', relative)) });
}
report.probeHome = scratch;
report.conclusion = 'Bundled tool versions and native binding bytes are recorded. The upstream downloader verifies archive SHA-256 before extraction; expected archive checksums are distinct from computed executable hashes. This audit does not establish full app or provider parity.';
fs.writeFileSync(path.join(workspace, 'artifacts/upstream-ui/cherry-native-prerequisites-audit.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!report.upstreamBundleCheck.passed || report.nativeBindings.some(row => !row.artifact) || report.tools.some(row => row.marker !== row.declaredVersion || row.binaries.some(x => !x) || (row.versionProbe && row.versionProbe.exitCode !== 0))) process.exitCode = 1;
