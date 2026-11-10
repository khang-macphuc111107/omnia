import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const modulePath = new URL('./run-static-checks.mjs', import.meta.url);
const nodeCheck = (id, program, timeoutMs = 3000) => ({ id, command: process.execPath, args: ['-e', program], timeoutMs });

test('static checks preserve failure exits, continue independent checks and save logs', async () => {
  const { runChecks } = await import(modulePath);
  const dir = await mkdtemp(path.join(tmpdir(), 'omnia-ci-'));
  try {
    const result = await runChecks({ cwd: dir, outputDir: path.join(dir, 'logs'), checks: [
      nodeCheck('first', "console.log('positive'); process.exit(0)"),
      nodeCheck('broken', "console.error('reproduced failure'); process.exit(7)"),
      nodeCheck('last', "console.log('continued'); process.exit(0)"),
    ], quiet: true });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.checks.map((c) => c.exitCode), [0, 7, 0]);
    assert.match(await readFile(path.join(dir, 'logs', 'broken.txt'), 'utf8'), /reproduced failure/);
    assert.match(await readFile(path.join(dir, 'logs', 'last.txt'), 'utf8'), /continued/);
    const saved = JSON.parse(await readFile(path.join(dir, 'logs', 'summary.json'), 'utf8'));
    assert.equal(saved.result, 'failed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('static checks fail on spawn errors and timeouts rather than reporting success', async () => {
  const { runChecks } = await import(modulePath);
  const dir = await mkdtemp(path.join(tmpdir(), 'omnia-ci-'));
  try {
    const result = await runChecks({ cwd: dir, outputDir: path.join(dir, 'logs'), quiet: true, checks: [
      { id: 'missing', command: path.join(dir, 'missing-command'), args: [], timeoutMs: 1000 },
      nodeCheck('timeout', 'setInterval(() => {}, 1000)', 60),
    ] });
    assert.equal(result.exitCode, 1);
    assert.equal(result.checks[0].result, 'spawn-error');
    assert.equal(result.checks[1].result, 'timed-out');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('empty check lists are rejected', async () => {
  const { runChecks } = await import(modulePath);
  await assert.rejects(runChecks({ checks: [], quiet: true }), /empty/i);
});

test('workflow linter is part of the default static check order', async () => {
  const { STATIC_CHECKS } = await import(modulePath);
  assert.equal(STATIC_CHECKS[0].id, 'workflow-lint');
  assert.equal(STATIC_CHECKS[0].args.at(-1), 'scripts/ci/lint-workflows.mjs');
});
