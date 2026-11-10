// Read-only NotebookLM adapter contract audit. No credentials are loaded or
// sent; the live provider remains unverified until a user supplies a session.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const dir = path.join(root, 'upstream_extractions/web-apis/gemini-notebook-web');
const out = path.join(root, 'artifacts/upstream-ui/notebooklm-contract-audit.json');
const source = fs.readFileSync(path.join(dir, 'src/notebook.rs'), 'utf8');
const spec = fs.readFileSync(path.join(dir, 'SPEC_AND_ADAPTER.md'), 'utf8');
const report = { generatedAt: new Date().toISOString(), package: 'gemini-notebook-web-adapter', revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim(), files: {}, contract: {}, checks: {}, limitations: ['No Google/NotebookLM credentials loaded.', 'No live authenticated request made.', 'RPC names and payload shapes are derived from checked-in spec; exact server response schema remains unverified.'] };
for (const f of ['Cargo.toml', 'Cargo.lock', 'SPEC_AND_ADAPTER.md', 'src/lib.rs', 'src/notebook.rs', 'src/session.rs']) { const p = path.join(dir, f); report.files[f] = { bytes: fs.statSync(p).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') }; }
report.contract.defaultBaseUrl = source.match(/new\(session: NotebookSession\)[\s\S]*?"([^"]+)"/)?.[1];
report.contract.rpcId = spec.match(/`(wXbZ7b)`/)?.[1];
report.contract.endpoint = spec.match(/Origin Target:\s*`([^`]+)`/)?.[1];
report.contract.auth = source.includes('HeaderMap') && source.includes('COOKIE');
report.contract.requestEncoder = source.includes('encode_f_req') && source.includes('generic');
report.contract.listImplementation = source.includes('Ok(vec![])') ? 'stub-empty-collection' : 'implemented';
report.checks = { manifestFilesPresent: Object.values(report.files).every(x => x.bytes > 0), cargoTest: false, releaseBuild: false, emptyStubDetected: report.contract.listImplementation === 'stub-empty-collection' };
const test = spawnSync('cargo', ['test', '--locked'], { cwd: dir, encoding: 'utf8', timeout: 120000 }); report.checks.cargoTest = test.status === 0; report.test = { command: 'cargo test --locked', status: test.status, outputTail: `${test.stdout}\n${test.stderr}`.slice(-3000) };
const build = spawnSync('cargo', ['build', '--release', '--locked'], { cwd: dir, encoding: 'utf8', timeout: 120000 }); report.checks.releaseBuild = build.status === 0; report.build = { command: 'cargo build --release --locked', status: build.status, outputTail: `${build.stdout}\n${build.stderr}`.slice(-3000) };
report.conclusion = report.checks.emptyStubDetected ? 'Contract and build verified; list_notebooks remains an explicit empty-result stub because no authenticated response fixture or server schema is available.' : 'Contract and build verified.';
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); if (!report.checks.manifestFilesPresent || !report.checks.cargoTest || !report.checks.releaseBuild) process.exitCode = 1;
