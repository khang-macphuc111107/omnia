const fs = require('node:fs');
const path = require('node:path');
const catalog = require('./catalog.cjs');
const reportPath = path.resolve(__dirname, '../../artifacts/upstream-ui/audit.json');
const runtimePath = path.resolve(__dirname, '../../artifacts/upstream-ui/runtime-audit.json');
const electronPath = path.resolve(__dirname, '../../artifacts/upstream-ui/electron-contract-audit.json');
const herdrPath = path.resolve(__dirname, '../../artifacts/upstream-ui/herdr-audit.json');
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const assets = read(reportPath)?.applications ?? [];
const runtime = read(runtimePath)?.applications ?? [];
const electron = read(electronPath)?.applications ?? [];
const herdr = read(herdrPath);
const rows = catalog.map(item => {
  const asset = assets.find(row => row.id === item.id) ?? {};
  const run = runtime.find(row => row.app === item.id || row.app === `${item.id}-desktop`) ?? {};
  const native = electron.find(row => row.app === item.id || row.app === `${item.id}-desktop`) ?? {};
  // A parseable report is not proof of original assets or their current hashes.
  const herdrProvenance = item.id === 'herdr' && herdr?.provenance?.repository && herdr?.provenance?.revision;
  const herdrRow = item.id === 'herdr' && herdr
    ? {
        assetStatus: herdrProvenance ? 'source-provenance-recorded' : 'unverified',
        sourceClassification: herdrProvenance ? 'upstream-source-repository' : 'unverified'
      }
    : {};
  return { id: item.id, assetStatus: herdrRow.assetStatus ?? asset.status ?? 'missing-report', sourceClassification: herdrRow.sourceClassification ?? asset.sourceClassification ?? item.sourceClassification, mainExists: run.mainExists, electronImport: native.electronImport, runtimeParity: run.runtimeParity ?? native.runtimeParity ?? 'unverified' };
});
const incomplete = rows.filter(row => row.assetStatus !== 'original-assets-verified' || row.runtimeParity !== 'verified');
const report = { generatedAt: new Date().toISOString(), evidenceKind: 'legacy-static-gate', limitations: 'Reads legacy asset/entrypoint/static Electron reports only. Does not aggregate newer native UI, provider, persistence or packaging evidence; incompleteCount is not an app completion percentage.', complete: incomplete.length === 0, incompleteCount: incomplete.length, applications: rows, conclusion: incomplete.length ? 'Legacy gate has unmet evidence requirements; inspect focused reports for current per-app progress.' : 'Legacy gate requirements met; full application behavior is not established by this script.' };
if (process.argv[2]) { const output = path.resolve(process.argv[2]); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
for (const row of rows) console.log(`${row.id}: assets=${row.assetStatus} runtime=${row.runtimeParity}`);
process.exitCode = report.complete ? 0 : 1;
