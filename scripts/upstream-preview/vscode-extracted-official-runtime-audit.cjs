const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const workspace=path.resolve(__dirname,'../..');
const extracted=path.join(workspace,'upstream_extractions/ide/vscode-core');
const installed=process.env.OMNIA_VSCODE_INSTALL||'C:/Users/khang/AppData/Local/Programs/Microsoft VS Code Insiders';
const build=process.env.OMNIA_VSCODE_BUILD||fs.readdirSync(installed,{withFileTypes:true}).filter(e=>e.isDirectory()&&fs.existsSync(path.join(installed,e.name,'resources/app/out/mainImpl.js'))).sort((a,b)=>fs.statSync(path.join(installed,b.name)).mtimeMs-fs.statSync(path.join(installed,a.name)).mtimeMs)[0]?.name;
if(!build)throw new Error('No versioned official VS Code installation found');
const originalApp=path.join(installed,build,'resources/app');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-vscode-official-runtime-'));
const stagedRuntime=path.join(scratch,'runtime');
const stagedBuild=path.join(stagedRuntime,build);
const stagedApp=path.join(stagedBuild,'resources/app');
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 fs.mkdirSync(stagedApp,{recursive:true});
 const copied=[]; const skipped=[];
 function copy(source,destination){if(!fs.existsSync(source)){skipped.push({source,destination,reason:'missing-source'});return;} fs.cpSync(source,destination,{recursive:true,errorOnExist:true,force:false,dereference:true});copied.push({source,destination});}
 copy(path.join(installed,'Code - Insiders.exe'),path.join(stagedRuntime,'Code - Insiders.exe'));
 for(const entry of fs.readdirSync(path.join(installed,build),{withFileTypes:true}))if(entry.isFile()||['locales','tools','appx','policies'].includes(entry.name))copy(path.join(installed,build,entry.name),path.join(stagedBuild,entry.name));
 for(const name of ['out','extensions','resources','node_modules','node_modules.asar.unpacked'])copy(path.join(extracted,name),path.join(stagedApp,name));
 for(const entry of fs.readdirSync(extracted,{withFileTypes:true}))if(entry.isFile())copy(path.join(extracted,entry.name),path.join(stagedApp,entry.name));
 copy(path.join(originalApp,'node_modules.asar'),path.join(stagedApp,'node_modules.asar'));
 console.log('RUNTIME_STAGED='+stagedRuntime);
 const hashes=Object.fromEntries(['out/mainImpl.js','out/vs/workbench/api/node/extensionHostProcess.js','package.json','product.json'].map(rel=>[rel,{installed:sha(path.join(originalApp,rel)),extracted:sha(path.join(extracted,rel)),staged:sha(path.join(stagedApp,rel))}]));
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p))})});
 const userData=path.join(scratch,'user-data'),extensions=path.join(scratch,'extensions'),logs=path.join(scratch,'logs'),project=path.join(scratch,'workspace');
 const env={};const allowed=new Set(['SYSTEMROOT','WINDIR','COMSPEC','PATH','PATHEXT','TEMP','TMP','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA','OS','PROCESSOR_ARCHITECTURE']);
 for(const [key,value]of Object.entries(process.env))if(allowed.has(key.toUpperCase()))env[key]=value;
 Object.assign(env,{HOME:scratch,USERPROFILE:scratch,APPDATA:path.join(scratch,'AppData/Roaming'),LOCALAPPDATA:path.join(scratch,'AppData/Local'),VSCODE_PORTABLE:path.join(scratch,'portable')});
 for(const dir of [userData,extensions,logs,project,env.APPDATA,env.LOCALAPPDATA,env.VSCODE_PORTABLE])fs.mkdirSync(dir,{recursive:true});
 const exe=path.join(stagedRuntime,'Code - Insiders.exe');
 const args=['--no-sandbox','--disable-gpu','--user-data-dir='+userData,'--extensions-dir='+extensions,'--logsPath='+logs,'--remote-debugging-port='+port,'--disable-workspace-trust','--disable-telemetry',project];
 let output='',exit=null,spawnError=null,child=null,cleanup=null,targets=[],evaluation=null;
 try{
 child=spawn(exe,args,{cwd:project,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.on('error',e=>spawnError=e.message);child.on('exit',(code,signal)=>exit={code,signal});
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 for(let i=0;i<50&&!targets.length&&!exit&&!spawnError;i++){await delay(500);try{const r=await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(1000)});if(r.ok)targets=await r.json()}catch{}}
 await delay(12000);
 const page=targets.find(x=>x.type==='page');
 if(page?.webSocketDebuggerUrl)evaluation=await new Promise((resolve,reject)=>{const socket=new WebSocket(page.webSocketDebuggerUrl);const timer=setTimeout(()=>{socket.close();reject(new Error('CDP evaluate timeout'))},5000);socket.onopen=()=>socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:"JSON.stringify({title:document.title,url:location.href,bodyText:(document.body?.innerText||'').slice(0,2000),domNodes:document.querySelectorAll('*').length})",returnByValue:true}}));socket.onmessage=e=>{const r=JSON.parse(e.data);if(r.id===1){clearTimeout(timer);socket.close();resolve(r.result?.result?.value||r.error)}};socket.onerror=()=>{clearTimeout(timer);reject(new Error('CDP websocket error'))}});
 }finally{if(child?.pid&&!exit){const r=spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{encoding:'utf8',windowsHide:true});cleanup={exitCode:r.status,stdout:r.stdout,stderr:r.stderr};await delay(800)}}
 const logFiles=[];function walk(dir){if(!fs.existsSync(dir))return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())walk(p);else if(entry.name.endsWith('.log'))logFiles.push({path:path.relative(logs,p),tail:fs.readFileSync(p,'utf8').slice(-12000)})}}walk(logs);
 const allLogs=output+'\n'+logFiles.map(x=>x.tail).join('\n');
 const extensionHostLog=logFiles.filter(x=>/exthost(?:\\|\/|\.log)/i.test(x.path));
 const report={generatedAt:new Date().toISOString(),sourceClassification:'extracted-VS-Code-application-with-official-patched-runtime-and-dependency-archive',isolation:{scratch,userData,extensions,project,logs,credentialsFromParentExcluded:true,outboundNetworkIsolation:'not-instrumented'},runtime:{original:installed,staged:stagedRuntime,build,exeSha256:sha(exe),dependencyArchiveSha256:sha(path.join(stagedApp,'node_modules.asar')),copied,skipped},sourceHashes:hashes,launch:{args,spawnError,exit,outputTail:output.slice(-16000),cleanup},cdp:{targets:targets.map(t=>({title:t.title,url:t.url,type:t.type})),evaluation},logs:logFiles,checks:{sourceEntrypointsPreserved:Object.values(hashes).every(h=>h.installed===h.extracted&&h.extracted===h.staged),cdpReached:targets.length>0,nonEmptyUi:typeof evaluation==='string'&&JSON.parse(evaluation).bodyText.length>0,failedSetPath:allLogs.includes('Failed to set path'),extensionHostCrash:/Extension host with pid.*exited with code: 1|extensionHost.*crashed with code 1/i.test(allLogs),updaterToolMissing:allLogs.includes('inno_updater.exe ENOENT'),extensionHostActivationObserved:extensionHostLog.some(x=>/activate|ExtensionService#_doActivateExtension/i.test(x.tail)),unknownAgentChannels:allLogs.includes('Unknown channel:'),sharedStorageOutsideScratch:allLogs.includes('khang\\.vscode-insiders-shared')||allLogs.includes('khang/.vscode-insiders-shared')},runtimeParity:'unverified',conclusion:'Bounded official-runtime probe of copied extracted application. Check runtime and extension-host evidence; full UI/IPC/provider parity remains unverified.'};
 fs.writeFileSync(path.join(workspace,'artifacts/upstream-ui/vscode-extracted-official-runtime-audit.json'),JSON.stringify(report,null,2)+'\n');
 fs.writeFileSync(path.join(workspace,'artifacts/upstream-ui/vscode-core-cdp-ui-audit.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({scratch,checks:report.checks,cleanup,logPaths:logFiles.map(x=>x.path)},null,2));
 if(spawnError||!report.checks.cdpReached||!report.checks.nonEmptyUi||!report.checks.sourceEntrypointsPreserved||!report.checks.extensionHostActivationObserved||report.checks.failedSetPath||report.checks.extensionHostCrash||report.checks.updaterToolMissing)process.exitCode=1;
})().catch(e=>{console.error(e);console.error('Scratch preserved: '+scratch);process.exitCode=1});
