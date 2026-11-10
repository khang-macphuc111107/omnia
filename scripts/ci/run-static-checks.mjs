import { spawn } from 'node:child_process';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const node = (id, ...args) => ({ id, command: process.execPath, args, timeoutMs: 120_000 });
export const STATIC_CHECKS = Object.freeze([
  node('workflow-lint', 'scripts/ci/lint-workflows.mjs'),
  node('workflow-contracts', 'scripts/ci/validate-workflows.mjs'),
  node('design-tokens', 'scripts/generate-design-tokens.mjs', '--check'),
  node('agent-catalog', 'docs/omnia-ultra/tools/validate-agent-catalog.mjs', '--check'),
  node('conversation-navigation', 'docs/omnia-ultra/tools/validate-conversation-navigation.mjs', '--check'),
  node('source-ledger-generation', 'docs/omnia-ultra/tools/generate-source-ledger.mjs', '--check'),
  node('source-ledger-integrity', 'docs/omnia-ultra/tools/validate-source-ledger.mjs', '--check'),
  node('upstream-catalog', 'scripts/upstream-preview/generate-upstream-capability-catalog.cjs', '--check'),
  node('native-acl', 'scripts/check-tauri-acl.mjs'),
  node('command-parity', 'scripts/check-tauri-command-parity.mjs'),
  node('typography', 'scripts/check-typography.mjs'),
  node('hit-targets', 'scripts/check-hit-targets.mjs'),
  node('import-boundaries', 'scripts/check-import-boundaries.mjs'),
  node('original-renderer-architecture', 'scripts/rebuild/architecture-guard.mjs'),
]);

async function execute(check, cwd, outputDir) {
  if (!/^[a-z][a-z0-9-]*$/.test(check.id)) throw new Error('Invalid check ID');
  const startedAt = new Date().toISOString();
  const chunks = [];
  let timedOut = false;
  let spawnError = false;
  const exitCode = await new Promise((resolve) => {
    const child = spawn(check.command, check.args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, check.timeoutMs ?? 120_000);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (error) => { spawnError = true; chunks.push(Buffer.from(`Spawn failed: ${error.code ?? 'unknown'}\n`)); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  const logPath = path.join(outputDir, `${check.id}.txt`);
  await writeFile(logPath, Buffer.concat(chunks));
  return {
    id: check.id, command: [check.command, ...check.args], startedAt,
    finishedAt: new Date().toISOString(), exitCode,
    result: spawnError ? 'spawn-error' : timedOut ? 'timed-out' : exitCode === 0 ? 'passed' : 'failed',
    log: path.relative(cwd, logPath).replaceAll('\\', '/'),
  };
}

export async function runChecks({ cwd = process.cwd(), outputDir = path.join(cwd, 'artifacts/ci/static'), checks = STATIC_CHECKS, quiet = false } = {}) {
  if (!checks.length) throw new Error('An empty static check list cannot pass');
  await mkdir(outputDir, { recursive: true });
  const results = [];
  for (const check of checks) {
    const result = await execute(check, cwd, outputDir);
    results.push(result);
    if (!quiet) console.log(`${result.result}: ${result.id} (exit ${result.exitCode ?? 'none'}); ${result.log}`);
  }
  const passed = results.every((check) => check.result === 'passed');
  const report = { schemaVersion: 1, result: passed ? 'passed' : 'failed', recordedAt: new Date().toISOString(), exitCode: passed ? 0 : 1, checks: results };
  await writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runChecks();
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## Static contracts\n\n| Check | Result | Log |\n| --- | --- | --- |\n${result.checks.map((r) => `| ${r.id} | ${r.result} | ${r.log} |`).join('\n')}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Static checks failed');
    process.exitCode = 1;
  }
}
