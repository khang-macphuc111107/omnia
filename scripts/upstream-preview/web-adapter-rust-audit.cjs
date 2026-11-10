const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../upstream_extractions/web-apis');
const apps = [
  ['chatgpt-web','chatgpt-web-adapter'], ['claude-web','claude-web-adapter'],
  ['gemini-web','gemini-web-adapter'], ['gemini-notebook-web','gemini-notebook-web-adapter']
];
const rows = apps.map(([dir, pkg]) => {
  const base = path.join(root, dir); const candidates = fs.existsSync(path.join(base,'target/debug')) ? fs.readdirSync(path.join(base,'target/debug'),{withFileTypes:true}).filter(e=>e.isFile() && e.name.includes(pkg.replaceAll('-','_'))).map(e=>e.name) : [];
  const lock = path.join(base,'Cargo.lock');
  const sourceFiles = fs.existsSync(path.join(base,'src')) ? fs.readdirSync(path.join(base,'src')).filter(file => file.endsWith('.rs')).map(file => fs.readFileSync(path.join(base,'src',file),'utf8')).join('\n') : '';
  const testCount = null;
  return { app: dir, package: pkg, manifest: fs.existsSync(path.join(base,'Cargo.toml')), lockfile: fs.existsSync(lock), lockSha256: fs.existsSync(lock)?crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex'):null, cargoTest: { command: 'cargo test --locked', status: 'not-executed', exitCode: null, testsPassed: testCount, testsFailed: null, note: 'Not executed by this inventory script.' }, releaseBuild: { command: 'cargo build --release --locked', status: 'not-executed', exitCode: null, artifactKind: 'library crate; no executable expected' }, debugArtifacts: candidates, staticContract: { hardcodedProviderUrls: [...sourceFiles.matchAll(/https:\/\/[^"'`]+/g)].map(match => match[0]), containsEmptyCollectionStub: sourceFiles.includes('Ok(vec![])') }, runtimeParity: 'unverified' };
});
const report={generatedAt:new Date().toISOString(),evidenceKind:'static-inventory',apps:rows,conclusion:'This script inventories files and hashes only. Build, test and runtime commands were not executed; no provider or upstream behavior parity is established.'};
const out=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../../artifacts/upstream-ui/web-adapter-rust-audit.json'); fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2));
