const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const source=path.join(root,'upstream_extractions/harnesses/hermes-agent');
const extra=process.env.HERMES_AUDIT_PYTHONPATH||'';
const env={...process.env,PYTHONPATH:[extra,source].filter(Boolean).join(path.delimiter)};
const r=spawnSync('python',['-m','hermes_cli.main','--help'],{cwd:source,env,encoding:'utf8',timeout:30000,windowsHide:true});
const report={generatedAt:new Date().toISOString(),command:'python -m hermes_cli.main --help',cwd:path.relative(root,source).replaceAll('\\','/'),pythonPath:env.PYTHONPATH||null,exitCode:typeof r.status==='number'?r.status:null,error:r.error?.code||null,stdout:(r.stdout||'').slice(-4000),stderr:(r.stderr||'').slice(-4000),runtimeParity:'unverified',limitations:['This probes the reconstructed Python module, not the bundled/native Hermes binary or provider behavior.','Set HERMES_AUDIT_PYTHONPATH to an isolated dependency directory containing declared packages.']};
const out=path.join(root,'artifacts/upstream-ui/hermes-cli-python-help-audit.json');fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({out,exitCode:report.exitCode,error:report.error,pythonPath:report.pythonPath},null,2));if(report.exitCode!==0)process.exitCode=1;
