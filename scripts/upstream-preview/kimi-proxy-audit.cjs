const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../upstream_extractions');
const kimi = path.join(root, 'harnesses/kimi-code');
const proxy = path.join(root, 'proxies/htmustc-proxy');
const run = (file, args, cwd) => {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
  const output = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`;
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
  const unavailable = result.error?.code === 'ENOENT';
  return { result, output, timedOut, unavailable, status: typeof result.status === 'number' ? result.status : null };
};
const pnpm = run('cmd.exe', ['/d', '/c', 'pnpm --filter @moonshot-ai/kimi-code run typecheck'], kimi);
const go = run('go', ['test', './...'], proxy);
const classify = (runResult, success, timeoutText) => {
  if (runResult.unavailable) return { status: 'unavailable', conclusion: 'required executable is unavailable on host' };
  if (runResult.timedOut) return { status: 'timeout', conclusion: timeoutText };
  if (runResult.status === 0) return { status: 'pass', conclusion: success };
  return { status: 'fail', conclusion: `command exited with status ${runResult.status}` };
};
const pnpmOutcome = classify(pnpm, 'typecheck passed', 'typecheck exceeded the 30s observation timeout');
const goOutcome = classify(go, 'tests passed', 'Go tests exceeded the 30s observation timeout');
const report = { generatedAt: new Date().toISOString(), kimi: { lockfile: fs.statSync(path.join(kimi, 'pnpm-lock.yaml')).size, command: 'pnpm --filter @moonshot-ai/kimi-code run typecheck', exitCode: pnpm.status, status: pnpmOutcome.status, timedOut: pnpm.timedOut, unavailable: pnpm.unavailable, error: pnpm.result.error?.message, outputTail: pnpm.output.slice(-1400), conclusion: pnpmOutcome.conclusion }, proxy: { command: 'go test ./...', exitCode: go.status, status: goOutcome.status, timedOut: go.timedOut, unavailable: go.unavailable, error: go.result.error?.message, outputTail: go.output.slice(-1000), conclusion: goOutcome.conclusion }, runtimeParity: 'unverified', notes: ['Kimi provider/session behavior was not exercised.', 'Proxy live HTTP/provider behavior was not exercised.'] };
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../artifacts/upstream-ui/kimi-proxy-audit.json'); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
