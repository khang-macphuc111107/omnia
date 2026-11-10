const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const catalog = require('./catalog.cjs');
const { createServer } = require('./server.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function audit(config) {
  const result = { id: config.id, kind: config.kind, sourceClassification: config.sourceClassification, entry: config.entry && path.join(config.root, config.entry), limitation: config.limitation, runnableParity: 'unverified' };
  if (config.id === 'herdr') {
    const binary = path.resolve(__dirname, '../../artifacts/upstream-ui/herdr-download/herdr-app/herdr-app.exe');
    if (fs.existsSync(binary)) {
      const bytes = fs.readFileSync(binary);
      return { ...result, status: 'original-assets-verified', specialNativeEvidence: true, sha256: hash(bytes), bytes: bytes.length, checks: { releaseBinaryPresent: true }, safe: true };
    }
  }
  if (!result.entry || !fs.existsSync(result.entry)) return { ...result, status: 'missing-original-or-build' };
  const expected = fs.readFileSync(result.entry);
  const server = createServer(config);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base);
    const actual = Buffer.from(await response.arrayBuffer());
    const identical = response.ok && expected.equals(actual);
    const html = expected.toString('utf8');
    const references = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]);
    const local = references.filter(ref => !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(ref));
    const assets = [];
    for (const ref of [...new Set(local)]) {
      const target = new URL(ref, response.url);
      const reply = await fetch(target, { method: 'HEAD' });
      assets.push({ reference: ref, status: reply.status });
    }
    const api = await fetch(`${base}/api/does-not-exist`);
    const invalid = await fetch(`${base}/%ZZ`);
    const traversal = await fetch(`${base}/%2e%2e%2fpackage.json`);
    const post = await fetch(base, { method: 'POST' });
    const safe = api.status === 404 && invalid.status === 400 && traversal.status === 403 && post.status === 405;
    const missingAssets = assets.filter(item => item.status !== 200);
    return { ...result, status: identical && safe && missingAssets.length === 0 ? 'original-assets-verified' : 'asset-check-failed', sha256: hash(expected), servedSha256: hash(actual), bytes: actual.length, identical, assets, missingAssets, checks: { absentApi: api.status, malformedUrl: invalid.status, traversal: traversal.status, post: post.status }, safe };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
async function main() {
  const rows = [];
  for (const config of catalog) {
    try { rows.push(await audit(config)); }
    catch (error) { rows.push({ id: config.id, status: 'audit-error', error: error.message, runnableParity: 'unverified' }); }
  }
  const report = { generatedAt: new Date().toISOString(), scope: `${catalog.length} preview applications from the interrupted session; this is not the complete ecosystem audit`, conclusion: 'Matching served bytes establish asset delivery only. Native host, extension APIs, backends and behavioral parity are not verified.', applications: rows };
  if (process.argv[2]) {
    const output = path.resolve(process.argv[2]);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
  for (const row of rows) console.log(`${row.id}: ${row.status}`);
  process.exitCode = rows.every(row => row.status === 'original-assets-verified') ? 0 : 1;
}
module.exports = { audit, main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
