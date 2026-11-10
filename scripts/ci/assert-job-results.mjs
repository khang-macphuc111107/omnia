import { appendFile } from 'node:fs/promises';

const required = ['renderer', 'native', 'native-shell', 'storage-contract', 'visual-contract'];
try {
  const jobs = JSON.parse(process.env.NEEDS_RESULTS ?? 'null');
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) throw new Error('Missing job results');
  const names = [...new Set([...required, ...Object.keys(jobs)])];
  if (names.some((id) => !/^[a-z][a-z0-9-]*$/.test(id))) throw new Error('Invalid job name');
  const rows = names.map((id) => ({ id, result: jobs[id]?.result ?? 'missing' }));
  const passed = rows.every((row) => row.result === 'success');
  for (const row of rows) console.log(`${row.id}: ${typeof row.result === 'string' ? row.result : 'invalid'}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## Quality checks\n\n| Job | Result |\n| --- | --- |\n${rows.map((r) => `| ${r.id} | ${r.result === 'success' ? 'success' : 'incomplete or failed'} |`).join('\n')}\n\n${passed ? 'All required jobs passed.' : 'Required jobs did not all pass. Inspect their logs and artifacts.'}\n`);
  }
  process.exitCode = passed ? 0 : 1;
} catch {
  console.error('Quality checks failed: valid results for every required job are required.');
  process.exitCode = 1;
}
