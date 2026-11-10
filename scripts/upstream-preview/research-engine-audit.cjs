const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../upstream_extractions/research');
const apps = ['orca-debate','perplexity-synthesis'];
const rows = apps.map(app => {
  const base=path.join(root,app); const pkg=JSON.parse(fs.readFileSync(path.join(base,'package.json'),'utf8')); const src=fs.readdirSync(path.join(base,'src')).filter(x=>x.endsWith('.ts')); const dist=fs.readdirSync(path.join(base,'dist')).filter(x=>x.endsWith('.js')); const index=fs.readFileSync(path.join(base,'dist/index.js'),'utf8'); return {app,package:{name:pkg.name,version:pkg.version,description:pkg.description},build:{command:'npm run build',status:'not-executed',exitCode:null,typescript:'5.9.3'},sourceFiles:src.length,distFiles:dist.length,distIndexSha256:crypto.createHash('sha256').update(index).digest('hex'),run:{command:'node dist/index.js',status:'not-executed',exitCode:null,output:null},sourceClassification:'reconstructed-source-package',runtimeParity:'unverified'};
});
const report={generatedAt:new Date().toISOString(),evidenceKind:'static-inventory',apps:rows,conclusion:'This script inventories files and hashes only. Build, test and runtime commands were not executed; no provider or upstream behavior parity is established.'};
const out=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../../artifacts/upstream-ui/research-engine-audit.json'); fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2));
