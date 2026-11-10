const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const workspace=path.resolve(__dirname,'../..');
const exe=path.join(workspace,'artifacts/upstream-ui/herdr-download/herdr-core.exe');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-herdr-core-restart-'));
const env={...process.env,HC_SESSION:'omnia-'+crypto.randomBytes(6).toString('hex'),XDG_STATE_HOME:path.join(home,'state'),XDG_CONFIG_HOME:path.join(home,'config'),HC_SETTLE_MS:'0'};
for(const n of ['HC_SOCKET','HC_TERMINAL_ID','SSH_CONNECTION','SSH_CLIENT','SSH_TTY']) delete env[n];
const commands=[]; const run=args=>{const r=spawnSync(exe,args,{cwd:home,env,windowsHide:true,encoding:'utf8',timeout:30000});const row={args,exitCode:r.status,error:r.error?.message||null,stdout:r.stdout||'',stderr:r.stderr||''};commands.push(row);return row};
const parse=r=>{try{return JSON.parse(r.stdout)}catch{return null}};
let firstStart,firstStatus,stop,secondStart,secondStatus,exec,cleanup;
try{
 firstStart=run(['server','start']); firstStatus=run(['server','status']);
 stop=run(['server','stop']);
 secondStart=run(['server','start']); secondStatus=run(['server','status']);
 exec=run(['exec','cmd.exe','/d','/c','echo OMNIA_HERDR_CORE_RESTART_OK']);
} finally { cleanup=run(['server','stop']); }
const report={generatedAt:new Date().toISOString(),sourceClassification:'official-upstream-release-binary',binaryPath:'artifacts/upstream-ui/herdr-download/herdr-core.exe',binarySha256:crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),isolation:{home,HC_SESSION:env.HC_SESSION,XDG_STATE_HOME:env.XDG_STATE_HOME,XDG_CONFIG_HOME:env.XDG_CONFIG_HOME},commands,observations:{firstStartSucceeded:firstStart?.exitCode===0,firstStatusSucceeded:firstStatus?.exitCode===0,firstPid:Number.isInteger(parse(firstStart)?.pid)&&parse(firstStart)?.pid===parse(firstStatus)?.pid,stopSucceeded:stop?.exitCode===0,secondStartSucceeded:secondStart?.exitCode===0,secondStatusSucceeded:secondStatus?.exitCode===0,secondPid:Number.isInteger(parse(secondStart)?.pid)&&parse(secondStart)?.pid===parse(secondStatus)?.pid,restartProducedNewPid:Number.isInteger(parse(firstStart)?.pid)&&Number.isInteger(parse(secondStart)?.pid)&&parse(firstStart).pid!==parse(secondStart).pid,execAfterRestart:exec?.exitCode===0&&exec.stdout.includes('OMNIA_HERDR_CORE_RESTART_OK'),cleanupSucceeded:cleanup?.exitCode===0},runtimeParity:'unverified',conclusion:'The official Herdr core restarted in an isolated state directory and accepted a real exec command after restart. This verifies core lifecycle recovery, not provider/agent parity.'};
fs.writeFileSync(path.join(workspace,'artifacts/upstream-ui/herdr-core-restart-audit.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
if(!Object.values(report.observations).every(Boolean)) process.exitCode=1;
