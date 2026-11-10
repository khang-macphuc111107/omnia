const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),cwd=path.join(root,'upstream_extractions/downloaders/idm-multistream'),binary=path.join(cwd,'target/release/idm-download.exe');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(SystemRoot|WINDIR|TEMP|TMP|PATH|PATHEXT|COMSPEC|SYSTEMDRIVE)$/i.test(k)));
async function run(mode){
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-idm-audit-')),dest=path.join(scratch,'download.bin');
 const payload=Buffer.alloc(mode==='tiny'?1:2*1024*1024);for(let i=0;i<payload.length;i++)payload[i]=(i*31+7)&255;
 const negative=['http500','ignored-range','truncated','bad-content-range'].includes(mode),sentinel=Buffer.from('preserve-existing-destination');if(negative)fs.writeFileSync(dest,sentinel);
 if(mode==='resume-missing'||mode==='resume-changed'){
 fs.writeFileSync(path.join(scratch,'download.idm.json'),JSON.stringify({url:'PLACEHOLDER',destination_path:dest,total_size:payload.length,etag:'"old"',last_modified:null,chunks:[{chunk_id:0,start:0,end:payload.length-1,downloaded:payload.length,is_completed:true}]}));
 if(mode==='resume-changed')fs.writeFileSync(dest+'.part',Buffer.alloc(payload.length,99));
 }
 let active=0,peak=0,stdout='',stderr='',child,timer,timedOut=false,spawnError=null;const requests=[];
 const server=http.createServer((req,res)=>{
  if(req.method==='HEAD'){res.writeHead(200,{'Content-Length':payload.length,'Accept-Ranges':'bytes','ETag':'"new"'});return res.end()}
  const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');if(!m){res.writeHead(400);return res.end()}
  const start=Number(m[1]),end=m[2]?Number(m[2]):payload.length-1,row={start,end,startedAt:Date.now()};requests.push(row);active++;peak=Math.max(peak,active);res.once('close',()=>{active--;row.closedAt=Date.now()});
  if(mode==='http500'){res.writeHead(500);return res.end()}
  if(start>end||end>=payload.length){res.writeHead(416);return res.end()}
  const body=mode==='ignored-range'?payload:payload.subarray(start,end+1);
  res.writeHead(mode==='ignored-range'?200:206,{'Content-Length':body.length,...(mode==='ignored-range'?{}:{'Content-Range':mode==='bad-content-range'?`bytes 0-0/${payload.length}`:`bytes ${start}-${end}/${payload.length}`})});
  setTimeout(()=>{if(res.destroyed)return;if(mode==='truncated'){res.write(body.subarray(0,Math.max(1,Math.floor(body.length/2))));return setTimeout(()=>res.destroy(),20)}res.end(body)},60);
 });
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const args=[`http://127.0.0.1:${server.address().port}/payload.bin`,'-o',dest,'-c','4','--min-chunk','64','--limit-bps','1048576'];
  if(mode==='resume-missing'||mode==='resume-changed'){
 const sidecar=path.join(scratch,'download.idm.json'),state=JSON.parse(fs.readFileSync(sidecar,'utf8'));state.url=args[0];if(mode==='resume-missing')state.etag='"new"';fs.writeFileSync(sidecar,JSON.stringify(state));
 }
 child=spawn(binary,args,{cwd,env,windowsHide:true});child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const startedAt=Date.now();
  const exitCode=await new Promise(resolve=>{child.once('error',e=>{spawnError=e.message;resolve(null)});child.once('close',resolve);timer=setTimeout(()=>{timedOut=true;child.kill()},30000)});
  const actual=fs.existsSync(dest)?fs.readFileSync(dest):null,percentages=[...stdout.matchAll(/\s(\d+(?:\.\d+)?)%/g)].map(m=>Number(m[1]));
  const checks=negative?{failedTransferRejected:exitCode!==null&&exitCode!==0,existingDestinationPreserved:actual!==null&&actual.equals(sentinel)}:{processExitZero:exitCode===0,fileSize:actual!==null&&actual.length===payload.length,sha256Matches:actual!==null&&hash(actual)===hash(payload),progressSamplesPresent:percentages.length>0,progressBounded:percentages.length>0&&percentages.every(v=>v>=0&&v<=100),...(mode==='tiny'?{}:{parallelRangeTraffic:peak>=2})};
  Object.assign(checks,{completedWithinTimeout:!timedOut,processStarted:spawnError===null,
    rateLimitObserved: mode === 'range' || mode === 'resume-missing' || mode === 'resume-changed' ? (Date.now()-startedAt >= 1800) : true});
  return {mode,scratch,command:{binary,args},exitCode,timedOut,spawnError,checks,observations:{elapsedMs:Date.now()-startedAt,rangeRequests:requests.length,peakActiveRanges:peak,requests,percentages,actualBytes:actual?.length??null,actualSha256:actual?hash(actual):null,expectedSha256:hash(payload)},stdout,stderr};
 }finally{clearTimeout(timer);if(child&&child.exitCode===null)child.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
}
(async()=>{
 const report={generatedAt:new Date().toISOString(),evidenceKind:'executed-loopback-behavior',binary:{path:binary,sha256:hash(fs.readFileSync(binary))},scope:'Omnia Rust engine only; installed IDM not executed',cases:[],runtimeParity:'unverified'};
 for(const mode of process.argv.includes('--negative')?['range','http500','ignored-range','truncated','bad-content-range','tiny','resume-missing','resume-changed']:['range'])report.cases.push(await run(mode));
 report.allChecksPassed=report.cases.every(c=>Object.values(c.checks).every(v=>v===true));
 const out=path.join(root,'artifacts/upstream-ui',process.argv.includes('--negative')?'idm-loopback-failure-audit.json':'idm-loopback-download-audit.json');fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({out,allChecksPassed:report.allChecksPassed,cases:report.cases.map(c=>({mode:c.mode,exitCode:c.exitCode,checks:c.checks,peak:c.observations.peakActiveRanges,progressSamples:c.observations.percentages.length}))},null,2));if(!report.allChecksPassed)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
