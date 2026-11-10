const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const repo = path.join(root, 'upstream_extractions', 'proxies', 'htmustc-proxy');
const outPath = path.resolve(process.argv[2] || path.join(root, 'artifacts/upstream-ui/proxy-deep-audit.json'));

function walk(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(p));
    else result.push(p);
  }
  return result;
}
function run(command, cwd = repo, timeout = 30_000) {
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout, windowsHide: true });
  return { command, exitCode: typeof r.status === 'number' ? r.status : null, timedOut: !!r.error, stdout: (r.stdout || '').slice(-1600), stderr: (r.stderr || '').slice(-1600) };
}
const files = walk(repo).filter(p => !p.includes(`${path.sep}.git${path.sep}`));
const goFiles = files.filter(p => p.endsWith('.go'));
const packages = new Map();
const endpoints = new Set();
const modules = [];
for (const file of goFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const pkg = (text.match(/^package\s+([A-Za-z0-9_]+)/m) || [])[1] || 'unknown';
  const rel = path.relative(repo, file).replaceAll('\\', '/');
  if (!packages.has(pkg)) packages.set(pkg, { name: pkg, files: 0, testFiles: 0, exportedTypes: new Set(), exportedFunctions: new Set(), exportedMethods: new Set() });
  const item = packages.get(pkg); item.files++; if (file.endsWith('_test.go')) item.testFiles++;
  for (const [, name] of text.matchAll(/^type\s+([A-Z][A-Za-z0-9_]*)/gm)) item.exportedTypes.add(name);
  for (const [, name] of text.matchAll(/^func\s+([A-Z][A-Za-z0-9_]*)\s*\(/gm)) item.exportedFunctions.add(name);
  for (const [, name] of text.matchAll(/^func\s+\([^\n]+\)\s+([A-Z][A-Za-z0-9_]*)\s*\(/gm)) item.exportedMethods.add(name);
  for (const [, endpoint] of text.matchAll(/[`\"](\/(?:api\/)?[A-Za-z0-9_./:{}-]{2,})[`\"]/g)) endpoints.add(endpoint);
  modules.push({ path: rel, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), bytes: fs.statSync(file).size });
}
const modText = fs.readFileSync(path.join(repo, 'go.mod'), 'utf8');
const deps = [...modText.matchAll(/^\s*([A-Za-z0-9._/-]+)\s+v([^\s]+)(?:\s+\/\/ indirect)?/gm)].map(m => ({ module: m[1], version: m[2], indirect: /indirect/.test(m[0]) }));
const pkgRows = [...packages.values()].map(x => ({ ...x, exportedTypes: [...x.exportedTypes].sort(), exportedFunctions: [...x.exportedFunctions].sort(), exportedMethods: [...x.exportedMethods].sort() })).sort((a,b) => a.name.localeCompare(b.name));
const report = {
  generatedAt: new Date().toISOString(), app: 'htmustc-proxy', sourceRoot: repo,
  provenance: 'reconstructed-source-package; no original upstream provenance asserted',
  inventory: { goFiles: goFiles.length, sourceFiles: goFiles.filter(x => !x.endsWith('_test.go')).length, testFiles: goFiles.filter(x => x.endsWith('_test.go')).length, packages: pkgRows, endpointLiterals: [...endpoints].sort(), sha256: modules.sort((a,b) => a.path.localeCompare(b.path)) },
  goMod: { module: (modText.match(/^module\s+(.+)$/m)||[])[1] || null, goVersion: (modText.match(/^go\s+(.+)$/m)||[])[1] || null, dependencies: deps },
  execution: { goVersion: run('go version'), tests: run('go test ./internal/... ./cmd/...', repo, 120_000), vet: run('go vet ./internal/... ./cmd/...', repo, 120_000), build: run('go build ./cmd/htmustc-proxy ./cmd/flowproto', repo, 120_000) },
  conclusions: ['Static API, dependency, endpoint-literal and checksum inventory is verified from files present at audit time.', 'Go test/vet/build results are only verified when the Go toolchain is available; current environment may lack go.exe.', 'Live HTTP/provider behavior, credentials, deployment and parity with any external service remain unverified.']
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ outPath, packages: pkgRows.length, goFiles: goFiles.length, testFiles: report.inventory.testFiles, goExit: report.execution.goVersion.exitCode }, null, 2));
