const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const electron = path.resolve(__dirname, '../../upstream_extractions/harnesses/opencode/node_modules/.bun/electron@44.9.1+759ce506b1ed1a42/node_modules/electron/dist/electron.exe');
const script = path.resolve(__dirname, 'idm-electron-extension-runtime.cjs');
const out = path.resolve(__dirname, '../../artifacts/upstream-ui/idm-electron-extension-runtime.json');
try { fs.rmSync(out, { force: true }); } catch {}
const child = spawn(electron, ['--no-sandbox', script], { cwd: path.resolve(__dirname, '../..'), stdio: 'inherit', env: { ...process.env, IDM_AUDIT_OUT: out } });
const timer = setTimeout(() => { child.kill(); process.exitCode = 2; }, 40000);
child.on('exit', (code, signal) => { clearTimeout(timer); console.log(`probe-exit code=${code} signal=${signal}`); process.exitCode = code ?? 1; });
