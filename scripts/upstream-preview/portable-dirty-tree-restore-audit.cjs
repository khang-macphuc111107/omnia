const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const workspace=path.resolve(__dirname,'../..');
const manifestPath=process.argv[2];if(!manifestPath)throw Error('Pass the backup manifest path');
const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
const restoredRoot=process.env.OMNIA_RESTORE_ROOT?fs.realpathSync(process.env.OMNIA_RESTORE_ROOT):fs.mkdtempSync(path.join(path.dirname(path.resolve(manifestPath)),'restore-'));
if(!restoredRoot.startsWith(path.dirname(path.resolve(manifestPath))+path.sep))throw Error('Restore root must remain inside this backup directory');
const run=(cwd,args,allowFailure=false)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true,timeout:600000,maxBuffer:64*1024*1024});if(!allowFailure&&(r.error||r.status!==0))throw Error(`git ${args[0]}: ${r.error?.message||r.stderr}`);return r};
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const results=[];
try{
 for(const [i,backup]of manifest.backups.entries()){
  const root=path.join(restoredRoot,String(i).padStart(2,'0'));fs.mkdirSync(root,{recursive:true});
  run(root,['init','--quiet']);run(root,['config','core.longpaths','true']);run(root,['config','core.autocrlf','false']);run(root,['config','core.symlinks','false']);
  const bundle=path.resolve(manifest.destination,backup.bundle);
  if(backup.shallow){
   const shallow=path.resolve(manifest.destination,backup.shallow.file);
   if(hash(shallow)!==backup.shallow.sha256)throw Error('Shallow boundary checksum mismatch');
   const destination=path.join(root,'.git','shallow');
   if(fs.existsSync(destination)){if(hash(destination)!==backup.shallow.sha256)throw Error('Existing shallow metadata differs')}else fs.copyFileSync(shallow,destination,fs.constants.COPYFILE_EXCL);
  }
  if(run(root,['cat-file','-e',backup.snapshot+'^{commit}'],true).status!==0)run(root,['fetch','--quiet',bundle,backup.ref]);
  if(run(root,['diff','--exit-code','--ignore-submodules=all',backup.snapshot,'--'],true).status!==0){
   run(root,['checkout','--quiet','--detach',backup.head]);
   if(backup.kind==='stash')run(root,['stash','apply','--index',backup.snapshot]);
  }
  const copied=[];
  for(const file of backup.untracked){
   if(file.type==='link'){copied.push({path:file.path,restored:false,reason:'link-recreation-required'});continue;}
   const source=path.resolve(path.dirname(bundle),'untracked',file.path),target=path.resolve(root,file.path);
   if(!source.startsWith(path.dirname(bundle)+path.sep)||!target.startsWith(root+path.sep))throw Error('Untracked path outside backup or restore');
   fs.mkdirSync(path.dirname(target),{recursive:true});if(!fs.existsSync(target))fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
   copied.push({path:file.path,restored:hash(target)===file.sha256});
  }
  const diff=run(root,['diff','--exit-code','--ignore-submodules=all',backup.snapshot,'--'],true);
  const actualIndexTree=run(root,['write-tree']).stdout.trim();
  const expectedIndexTree=run(root,['rev-parse',backup.kind==='stash'?`${backup.snapshot}^2^{tree}`:`${backup.snapshot}^{tree}`]).stdout.trim();
  const item={source:backup.root,restored:root,revision:backup.snapshot,workingTreeMatchesSnapshot:diff.status===0&&!diff.error,indexTreeMatches:actualIndexTree===expectedIndexTree,expectedIndexTree,actualIndexTree,copied,diffError:diff.stderr};results.push(item);
  console.log(JSON.stringify({source:item.source,workingTreeMatchesSnapshot:item.workingTreeMatchesSnapshot,indexTreeMatches:item.indexTreeMatches,untracked:copied.length}));
 }
 const report={generatedAt:new Date().toISOString(),manifestPath,restoredRoot,networkRequired:false,results,checks:{allTrackedSnapshotsRestored:results.every(x=>x.workingTreeMatchesSnapshot),allIndexesRestored:results.every(x=>x.indexTreeMatches),allUntrackedRegularFilesRestored:results.every(x=>x.copied.every(f=>f.restored))},limitations:manifest.limitations};
 fs.writeFileSync(path.join(restoredRoot,'restore-report.json'),JSON.stringify(report,null,2)+'\n');fs.writeFileSync(path.join(workspace,'artifacts/upstream-ui/portable-dirty-tree-restore-audit.json'),JSON.stringify(report,null,2)+'\n');
 if(Object.values(report.checks).some(v=>!v))process.exitCode=1;
}catch(error){console.error(error.message);console.error('Restored files retained at '+restoredRoot);process.exitCode=1;}
