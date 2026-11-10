import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./assert-job-results.mjs', import.meta.url));
const ids = ['renderer', 'native', 'native-shell', 'storage-contract', 'visual-contract'];
const passing = () => Object.fromEntries(ids.map((id) => [id, { result: 'success' }]));
const run = (value) => spawnSync(process.execPath, [cli], {
  encoding: 'utf8', env: { ...process.env, NEEDS_RESULTS: typeof value === 'string' ? value : JSON.stringify(value) },
});

test('aggregate passes only when every required job succeeded', () => {
  const result = run(passing());
  assert.equal(result.status, 0, result.stderr);
  for (const id of ids) assert.ok(result.stdout.includes(`${id}: success`));
});
for (const status of ['failure', 'cancelled', 'skipped', 'pending', 'timed_out', 'unknown', null]) {
  test(`aggregate rejects ${status} even when all other jobs pass`, () => {
    const jobs = passing(); jobs.native.result = status;
    assert.equal(run(jobs).status, 1);
  });
}
test('aggregate rejects missing jobs and empty results', () => {
  const jobs = passing(); delete jobs.renderer;
  assert.equal(run(jobs).status, 1);
  assert.equal(run({}).status, 1);
});
test('independent native shell failure or omission cannot pass aggregate', () => {
  for (const result of ['failure', 'cancelled', 'skipped']) {
    const jobs = passing(); jobs['native-shell'].result = result;
    assert.equal(run(jobs).status, 1);
  }
  const jobs = passing(); delete jobs['native-shell'];
  assert.equal(run(jobs).status, 1);
});
test('aggregate rejects malformed results and extra failed jobs', () => {
  for (const value of ['{broken', 'null', '[]', '"success"']) assert.equal(run(value).status, 1);
  assert.equal(run({ ...passing(), extra: { result: 'failure' } }).status, 1);
});
