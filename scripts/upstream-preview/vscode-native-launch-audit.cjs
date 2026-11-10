const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { execFileSync } = require('node:child_process');

const exe = process.env.VSCODE_EXE || 'C:\\Users\\khang\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe';
const out = path.resolve(process.argv[2] || path.join(__dirname, '../../artifacts/upstream-ui/vscode-native-runtime-audit.json'));
const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'omnia-vscode-native-'));
const userData = path.join(scratch, 'user-data');
const extensions = path.join(scratch, 'extensions');
const logFile = path.join(scratch, 'launch.log');
fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(extensions, { recursive: true });
const started = new Date().toISOString();
const child = spawn(exe, ['--user-data-dir', userData, '--extensions-dir', extensions, '--disable-extensions', '--disable-gpu', '--skip-welcome-page', '--new-window', '--verbose'], {
  detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VSCODE_LOGS: path.join(scratch, 'logs') }
});
const chunks = []; child.stdout.on('data', b => chunks.push(b)); child.stderr.on('data', b => chunks.push(b));
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await wait(15000);
  const text = Buffer.concat(chunks).toString('utf8'); fs.writeFileSync(logFile, text);
  let ps = ''; try { ps = execFileSync('powershell.exe', ['-NoProfile','-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' } | Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }); } catch {}
  const alive = !child.exitCode && child.signalCode === null;
  const report = { generatedAt: new Date().toISOString(), startedAt: started, executable: exe, executableBytes: fs.statSync(exe).size, executableSha256: crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'), version: (() => { try { return execFileSync('powershell.exe', ['-NoProfile','-Command', `(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`], { encoding: 'utf8', windowsHide: true }).trim(); } catch { return null; } })(), scratch, userData, extensions, launch: { pid: child.pid, survived15Seconds: alive, exitCode: child.exitCode, signal: child.signalCode, stdoutStderrTail: text.slice(-4000), processSnapshot: ps.trim() }, conclusion: alive ? 'Native VS Code Insiders process survived 15 seconds in an isolated profile; GUI/IPC/extension-host parity requires separate observation.' : 'Native VS Code Insiders exited before the 15-second probe completed; inspect captured logs before claiming runtime parity.' };
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
  if (alive) { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
})().catch(e => { console.error(e); process.exitCode = 1; });
