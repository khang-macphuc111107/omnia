// Focused official native UI/provider audit; use a disposable PM installation.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const upstream = path.join(root, 'upstream_extractions/harnesses/hermes-agent');
const wrapper = path.join(root, 'upstream_extractions/desktop-apps/hermes-desktop');
const pm = process.env.OMNIA_HERMES_PM_ROOT;
if (!pm) throw new Error('Set OMNIA_HERMES_PM_ROOT to a disposable isolated Hermes PM installation.');
const activation = JSON.parse(fs.readFileSync(path.join(pm, 'activation.json'), 'utf8').replace(/^\uFEFF/, ''));
const facts = JSON.parse(fs.readFileSync(activation.__HERMES_ACTIVATED, 'utf8'));
const python = path.join(facts.packages.venv.environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const fromUpstream = createRequire(path.join(upstream, 'package.json'));
const electron = fromUpstream('electron');
const { chromium } = fromUpstream('playwright');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-hermes-native-replay-'));
const out = path.resolve(process.argv[2] || path.join(root, 'artifacts/upstream-ui/hermes-native-desktop-replay.json'));
fs.mkdirSync(path.dirname(out), { recursive: true });
const configPath = path.join(pm, 'home/config.yaml');
const previousConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
if (previousConfig) fs.writeFileSync(path.join(scratch, 'config-before.yaml'), previousConfig);
const report = { generatedAt:new Date().toISOString(), scratch, pm, sourceClassification:'official-upstream-desktop-via-omnia-launcher', requests:[], checks:{}, steps:[], cleanup:{}, limitations:['Loopback mock only; real providers/tools unverified.','Outbound traffic not instrumented.','Focused UI sample; full UI parity and packaged distribution unverified.'] };
const env = {};
const allowed = new Set(['SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP','OS','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA']);
for (const [key,value] of Object.entries(process.env)) if (allowed.has(key.toUpperCase())) env[key]=value;
for (const key of ['PATH','PYTHONPATH','PLAYWRIGHT_BROWSERS_PATH','__HERMES_ACTIVATED']) if (activation[key]) env[key]=activation[key];
Object.assign(env,{HOME:scratch,USERPROFILE:scratch,APPDATA:path.join(scratch,'AppData/Roaming'),LOCALAPPDATA:path.join(scratch,'AppData/Local'),HERMES_HOME:path.join(pm,'home'),HERMES_RUNTIME_DIR:path.join(pm,'runtime'),HERMES_DESKTOP_HERMES_ROOT:upstream,HERMES_DESKTOP_PYTHON:python,HERMES_DESKTOP_USER_DATA_DIR:path.join(scratch,'user-data'),OPENAI_API_KEY:'loopback-key',NO_COLOR:'1',PYTHONIOENCODING:'utf-8'});
for (const dir of [env.APPDATA,env.LOCALAPPDATA]) fs.mkdirSync(dir,{recursive:true});
const state={mode:'normal',held:null,browser:null,child:null,log:null};
const server=http.createServer((req,res)=>{
  let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{
    let body={};try{body=JSON.parse(raw||'{}');}catch{}
    report.requests.push({at:new Date().toISOString(),method:req.method,path:req.url,model:body.model,stream:body.stream,mode:state.mode,roles:body.messages?.map(m=>m.role)});
    if(req.method==='GET'&&req.url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({object:'list',data:[{id:'gpt-4o-mini',object:'model'}]}));return;}
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
    if(state.mode==='denied'){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'OMNIA_AUDIT_PROVIDER_DENIED',type:'authentication_error',code:'invalid_api_key'}}));return;}
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'title',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'Omnia native replay'},finish_reason:'stop'}]}));return;}
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
    const chunk=content=>`data: ${JSON.stringify({id:'audit',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})}\n\n`;
    if(state.mode==='hold'){const held={startedAt:Date.now(),closedAt:null};state.held=held;res.on('close',()=>held.closedAt=Date.now());res.write(chunk('OMNIA_CANCEL_MEASURED'));return;}
    res.write(chunk('OMNIA_HERMES_DESKTOP_OK'));res.write(`data: ${JSON.stringify({id:'audit',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\n`);res.end('data: [DONE]\n\n');
  });
});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(200);}throw new Error('Timed out waiting for observed state');}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function capture(page,name){const base=path.join(scratch,name);await page.screenshot({path:base+'.png'});const aria=await page.locator('body').ariaSnapshot();fs.writeFileSync(base+'.aria.txt',aria);report.steps.push({name,url:page.url(),aria,screenshot:base+'.png'});}
function stopDesktop(){if(state.child?.pid){const pid=state.child.pid;if(state.child.exitCode===null){const r=spawnSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,encoding:'utf8'});report.cleanup.desktop={pid,taskkillExit:r.status,output:(r.stdout||'')+(r.stderr||'')};}else{report.cleanup.desktop={pid,alreadyExited:true,exitCode:state.child.exitCode};}state.child=null;}if(state.log!==null){fs.closeSync(state.log);state.log=null;}}
async function launch(port){state.log=fs.openSync(path.join(scratch,'electron.log'),'a');state.child=spawn(electron,[wrapper,'--no-sandbox','--disable-gpu',`--remote-debugging-port=${port}`],{cwd:scratch,env,stdio:['ignore',state.log,state.log],windowsHide:true});state.child.on('error',e=>report.spawnError=e.message);await until(async()=>{try{state.browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);return true;}catch{return false;}});const page=state.browser.contexts().flatMap(c=>c.pages()).find(p=>!p.url().startsWith('devtools:'));await page.getByRole('textbox',{name:'Message',exact:true}).waitFor({timeout:60000});return page;}
async function send(page,text){await page.getByRole('textbox',{name:'Message',exact:true}).fill(text);await page.getByRole('button',{name:'Send',exact:true}).click();}
(async()=>{
  try{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;env.OPENAI_BASE_URL=`http://127.0.0.1:${port}/v1`;
    fs.writeFileSync(configPath,`model:\n  default: gpt-4o-mini\n  provider: custom\n  base_url: ${env.OPENAI_BASE_URL}\n  api_key: loopback-key\ngateway:\n  standalone: true\n`);
    report.sourceRevision=spawnSync('git',['rev-parse','HEAD'],{cwd:upstream,encoding:'utf8'}).stdout.trim();
    report.artifacts=['package-lock.json','apps/desktop/dist/electron-main.mjs'].map(f=>({path:f,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(upstream,f))).digest('hex')}));
    const cdp=await freePort();let page=await launch(cdp);
    if(await page.getByRole('button',{name:'No thanks',exact:true}).count())await page.getByRole('button',{name:'No thanks',exact:true}).click();
    await send(page,'Reply with a short confirmation for the desktop audit.');await until(async()=>(await page.locator('body').innerText()).includes('OMNIA_HERMES_DESKTOP_OK'),60000);report.checks.composerProviderStreaming=true;await capture(page,'response');
    state.mode='hold';await send(page,'Measure cancellation connection closure.');await until(()=>!!state.held,60000);await capture(page,'streaming');const stopAt=Date.now();await page.getByRole('button',{name:'Stop',exact:true}).last().click();await until(()=>state.held.closedAt!==null);report.checks.cancelClosedHttp=true;report.cancelLatencyMs=state.held.closedAt-stopAt;await capture(page,'stopped');
    state.mode='denied';await send(page,'Provider failure audit.');await until(async()=>(await page.locator('body').innerText()).includes('rejected your API key'),60000);report.checks.providerErrorVisible=true;await capture(page,'denied');
    state.mode='normal';const before=await page.getByText('OMNIA_HERMES_DESKTOP_OK',{exact:true}).count();await page.getByRole('button',{name:'Retry',exact:true}).click();await until(async()=>(await page.getByText('OMNIA_HERMES_DESKTOP_OK',{exact:true}).count())>before,60000);report.checks.retryRecovered=true;await capture(page,'recovered');
    const previousUrl=page.url();await state.browser.close();state.browser=null;stopDesktop();page=await launch(cdp);
    // An immediate forced exit can precede debounced active-tab persistence.
    // Preserve that observation, then reopen the durable backend session by ID.
    report.restartRouteRestoredAutomatically=page.url()===previousUrl;
    if(!report.restartRouteRestoredAutomatically){await capture(page,'restart-home');await page.goto(previousUrl);}
    await until(async()=>(await page.locator('body').innerText()).includes('OMNIA_HERMES_DESKTOP_OK'),60000);report.checks.restartMessagePersisted=true;report.checks.restartSessionRoute=page.url()===previousUrl;
    // DOM content can be present underneath the connecting overlay.
    await until(async()=>!(await page.getByText('CONNECTING',{exact:true}).isVisible()),60000);
    await until(async()=>await page.getByText('OMNIA_HERMES_DESKTOP_OK',{exact:true}).first().isVisible(),60000);
    report.checks.restartVisibleReady=true;await capture(page,'restarted');
  }catch(error){report.error=error.stack;process.exitCode=1;}
  finally{
    if(state.browser)await state.browser.close().catch(()=>{});stopDesktop();const stop=spawnSync(python,['hermes','gateway','stop'],{cwd:upstream,env,encoding:'utf8',timeout:30000,windowsHide:true});report.cleanup.gateway={exitCode:stop.status,stdout:stop.stdout?.slice(-2000),stderr:stop.stderr?.slice(-2000),error:stop.error?.message};server.closeAllConnections();await new Promise(r=>server.close(r));
    if(previousConfig)fs.writeFileSync(configPath,previousConfig);else if(fs.existsSync(configPath))fs.unlinkSync(configPath);report.cleanup.configRestored=previousConfig?fs.readFileSync(configPath).equals(previousConfig):!fs.existsSync(configPath);fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({report:out,checks:report.checks,error:report.error,cleanup:report.cleanup},null,2));
  }
})();
