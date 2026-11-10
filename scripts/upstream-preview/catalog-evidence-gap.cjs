const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../');
const scopePath = path.resolve(root, 'artifacts/upstream-ui/scope-reconciliation-catalog-current.json');
const outPath = path.resolve(root, process.argv[2] || 'artifacts/upstream-ui/catalog-evidence-gap-current.json');
const scope = JSON.parse(fs.readFileSync(scopePath, 'utf8'));
const evidenceDir = path.resolve(root, 'artifacts/upstream-ui');
const evidenceFiles = fs.readdirSync(evidenceDir).filter(name => /\.(json|log|md|png|html)$/i.test(name));
const normalize = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
const aliases = {
  'chatgpt-desktop': ['chatgpt'],
  'claude-desktop': ['claude'],
  'herdr-app': ['herdr'],
  'idm-multistream': ['idm'],
  'gemini-notebook-web': ['gemini', 'notebook'],
  'gemini-web': ['gemini'],
  'opencode-desktop': ['opencode'],
  'hermes-desktop': ['hermes'],
  // Focused round-2 audits use grouped artifact names. These aliases only
  // improve inventory attribution; they never change runtimeParityClaim.
  'orca-cli': ['orca-pi', 'orca-components'],
  'orca-desktop': ['orca-components'],
  'orca-harness': ['orca-pi', 'harness-gap'],
  'pi-harness': ['orca-pi', 'harness-gap'],
  'agy-harness': ['agy-cli-harness', 'harness-gap'],
  'claude-cli-desktop': ['claude', 'harness-gap'],
  'claude-harness': ['claude', 'harness-gap'],
  'codex-desktop': ['codex', 'harness-gap'],
  'codex-app-unpacked': ['codex', 'harness-gap'],
  'deepseek-harness': ['harness-gap'],
  'droid-harness': ['orca-pi', 'harness-gap'],
  'opencode-harness': ['opencode', 'harness-gap'],
  'openhands-agent-sdk': ['openhands', 'harness-gap'],
  'cursor': ['research-ide'],
  'windsurf': ['research-ide'],
  'htmustc-proxy': ['proxy-deep-audit', 'proxy'],
  'orca-debate': ['orca-pi', 'orca-components', 'research-ide'],
  'perplexity-synthesis': ['research-ide'],
  'chatgpt-web': ['web-adapter', 'chatgpt-claude'],
  'claude-web': ['web-adapter', 'chatgpt-claude'],
};
const matchingEvidence = app => {
  const needles = [app, ...(aliases[app] || [])].map(normalize).filter(Boolean);
  return evidenceFiles.filter(file => {
    const token = normalize(file);
    return needles.some(needle => token.includes(needle));
  }).sort();
};
const rows = scope.applications.map(row => {
  const evidence = matchingEvidence(row.app);
  return {
    group: row.group,
    app: row.app,
    catalogCoverage: row.catalogCoverage,
    evidenceFileCount: evidence.length,
    evidenceFiles: evidence,
    provenanceOrInventoryEvidence: evidence.length > 0,
    runtimeParityClaim: 'unverified',
    gap: evidence.length ? 'Focused evidence exists; inspect each report for scope and limitations.' : 'No matching focused evidence artifact found; requires discovery/provenance/build/runtime audit.'
  };
});
const report = {
  generatedAt: new Date().toISOString(),
  evidenceKind: 'current-file-inventory-gap-report',
  sourceScope: { path: path.relative(root, scopePath).replaceAll('\\', '/'), modules: rows.length, cataloged: rows.filter(r => r.catalogCoverage === 'cataloged').length, outsideCatalog: rows.filter(r => r.catalogCoverage === 'outside-catalog').length },
  semantics: 'This report inventories matching evidence filenames only. A matching file is not proof of runtime parity, source completeness, or successful behavior; runtimeParityClaim stays unverified for every module until an independent focused audit says otherwise.',
  rows,
  summary: {
    modulesWithAnyEvidenceFilename: rows.filter(r => r.evidenceFileCount > 0).length,
    modulesWithoutMatchingEvidenceFilename: rows.filter(r => r.evidenceFileCount === 0).length,
    runtimeParityVerified: 0,
    wholeCatalogPasses: 0,
  }
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(`modules=${rows.length} cataloged=${report.sourceScope.cataloged} outside=${report.sourceScope.outsideCatalog} withEvidence=${report.summary.modulesWithAnyEvidenceFilename} withoutEvidence=${report.summary.modulesWithoutMatchingEvidenceFilename}`);
