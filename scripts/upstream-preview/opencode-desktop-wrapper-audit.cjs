const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const wrapper = path.join(root, 'upstream_extractions/desktop-apps/opencode-desktop/dist/main.js');
const bridge = pathToFileURL(path.join(path.dirname(wrapper), 'preload.js')).href;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-opencode-wrapper-'));
const run = (args, extra = {}) => {
  const r = spawnSync(process.execPath, args, { cwd: scratch, env: { ...process.env, ...extra }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error?.message };
};
const missingSource = run([wrapper], { OMNIA_OPENCODE_UPSTREAM: path.join(scratch, 'missing-upstream') });
const missingElectron = run([wrapper], { OMNIA_OPENCODE_ELECTRON: path.join(scratch, 'missing-electron.exe') });
const legacyBridge = run(['--input-type=module', '-e', `import {OpencodeDesktopBridge as bridge} from ${JSON.stringify(bridge)};for(const fn of [()=>bridge.sendIpc('test',{}),()=>bridge.spawnSubagent('test','test')]){try{await fn();process.exitCode=1;}catch(e){console.log(e.message)}}`]);
const checks = {
  missingSourceFails: missingSource.exitCode === 1 && missingSource.stderr.includes('not built'),
  missingElectronFails: missingElectron.exitCode === 1 && missingElectron.stderr.includes('executable is missing'),
  legacyBridgeRejects: legacyBridge.exitCode === 0 && legacyBridge.stdout.includes('cannot send IPC') && legacyBridge.stdout.includes('official OpenCode session/backend API'),
};
const report = { generatedAt: new Date().toISOString(), node: process.version, scratch, missingSource, missingElectron, legacyBridge, checks };
fs.writeFileSync(path.join(root, 'artifacts/upstream-ui/opencode-desktop-wrapper-audit.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ checks }, null, 2));
process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
