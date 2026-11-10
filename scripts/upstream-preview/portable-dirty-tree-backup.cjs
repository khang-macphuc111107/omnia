const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const workspace = path.resolve(__dirname, '../..');
const destinationParent = path.resolve(process.env.OMNIA_BACKUP_DIR || path.join(workspace, '../../backups'));
if (destinationParent.toLowerCase().startsWith(workspace.toLowerCase() + path.sep) || destinationParent.toLowerCase() === workspace.toLowerCase()) throw new Error('Backups must be outside the source checkout');
fs.mkdirSync(destinationParent, { recursive: true });
const destination = fs.mkdtempSync(path.join(destinationParent, 'omnia-dirty-trees-'));
const stamp = new Date().toISOString().replace(/[^0-9]/g, '');
const git = (cwd, args, options = {}) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000, windowsHide: true, ...options });
  if (r.error || r.status !== 0) throw new Error(`git ${args[0]} in ${cwd}: ${r.error?.message || r.stderr}`);
  return r.stdout;
};
const sha256 = file => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file);
  stream.on('data', b => hash.update(b));
  stream.on('error', reject);
  stream.on('end', () => resolve(hash.digest('hex')));
});
const textHash = value => crypto.createHash('sha256').update(value).digest('hex');
(async () => {
  const manifest = { generatedAt: new Date().toISOString(), workspace, destination, backups: [], limitations: ['Includes the outer repository plus dirty Git roots referenced by its index. Clean gitlink repositories and non-Git junction targets are not packaged.', 'Ignored files, dependency directories, external binaries and runtime environments are excluded.', 'Untracked links are recorded as links; their targets are not recursively copied.'], restore: ['Initialize an empty repository and fetch its repository.bundle using the saved ref.', 'For a stash snapshot: checkout the saved HEAD, then git stash apply --index the snapshot commit. For a HEAD snapshot: checkout it directly.', 'Copy untracked/ contents into that repository. Recreate any recorded links explicitly. Use aliases to restore junction mappings.'] };
  const candidates = new Map();
  candidates.set(fs.realpathSync(workspace).toLowerCase(), { root: fs.realpathSync(workspace), aliases: ['.'] });
  const index = git(workspace, ['ls-files', '--stage', '-z']);
  for (const entry of index.split('\0')) {
    const match = entry.match(/^160000 [0-9a-f]+ 0\t(.*)$/s);
    if (!match) continue;
    let real;
    try { real = fs.realpathSync(path.join(workspace, match[1])); } catch (error) { (manifest.unavailableGitlinks ||= []).push({ path: match[1], error: error.code }); continue; }
    const top = fs.realpathSync(git(real, ['rev-parse', '--show-toplevel']).trim());
    if (top.toLowerCase() !== real.toLowerCase()) throw new Error('Gitlink resolved to a parent repository: ' + match[1]);
    const key = real.toLowerCase();
    if (!candidates.has(key)) candidates.set(key, { root: real, aliases: [] });
    candidates.get(key).aliases.push(match[1]);
  }
  for (const candidate of candidates.values()) {
    const before = git(candidate.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!before && candidate.root.toLowerCase() !== workspace.toLowerCase()) continue;
    console.log('BACKUP_ROOT=' + candidate.root);
    const folder = path.join(destination, String(manifest.backups.length).padStart(2, '0'));
    fs.mkdirSync(folder);
    const head = git(candidate.root, ['rev-parse', 'HEAD']).trim();
    const stagedBefore = git(candidate.root, ['ls-files', '--stage', '-z']);
    const snapshot = git(candidate.root, ['-c', 'user.name=Omnia Backup', '-c', 'user.email=backup@local.invalid', 'stash', 'create', 'backup: preserve work before continued integration']).trim();
    const revision = snapshot || head;
    const ref = `refs/omnia-backups/${stamp}`;
    git(candidate.root, ['update-ref', ref, revision]);
    const bundle = path.join(folder, 'repository.bundle');
    git(candidate.root, ['bundle', 'create', bundle, ref]);
    const shallowPath = git(candidate.root, ['rev-parse', '--path-format=absolute', '--git-path', 'shallow']).trim();
    let shallow = null;
    if (fs.existsSync(shallowPath)) {
      const output = path.join(folder, 'shallow');
      fs.copyFileSync(shallowPath, output, fs.constants.COPYFILE_EXCL);
      shallow = { file: path.relative(destination, output), sha256: await sha256(output), roots: fs.readFileSync(output, 'utf8').trim().split(/\r?\n/) };
    }
    const verification = spawnSync('git', ['bundle', 'verify', bundle], { cwd: candidate.root, encoding: 'utf8', windowsHide: true, timeout: 180000 });
    if (verification.status !== 0 || verification.error) throw new Error('Bundle verification failed: ' + verification.stderr);
    const untracked = [];
    for (const rel of git(candidate.root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
      const source = path.resolve(candidate.root, rel);
      const output = path.resolve(folder, 'untracked', rel);
      if (!source.startsWith(candidate.root + path.sep) || !output.startsWith(folder + path.sep)) throw new Error('Untracked path outside source or destination');
      const st = fs.lstatSync(source);
      if (st.isSymbolicLink()) { untracked.push({ path: rel, type: 'link', target: fs.readlinkSync(source), targetCopied: false }); continue; }
      if (!st.isFile()) throw new Error('Unsupported untracked entry: ' + rel);
      const originalHash = await sha256(source);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(source, output, fs.constants.COPYFILE_EXCL);
      const copiedHash = await sha256(output);
      const afterHash = await sha256(source);
      if (originalHash !== copiedHash || originalHash !== afterHash) throw new Error('Untracked file changed during backup: ' + rel);
      untracked.push({ path: rel, bytes: st.size, sha256: copiedHash });
    }
    const after = git(candidate.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const stagedAfter = git(candidate.root, ['ls-files', '--stage', '-z']);
    const item = { ...candidate, head, snapshot: revision, kind: snapshot ? 'stash' : 'HEAD', ref, bundle: path.relative(destination, bundle), shallow, bundleBytes: fs.statSync(bundle).size, bundleSha256: await sha256(bundle), bundleVerified: true, statusBeforeSha256: textHash(before), statusAfterSha256: textHash(after), workingStatusPreserved: before === after, stagedIndexPreserved: stagedBefore === stagedAfter, untracked };
    manifest.backups.push(item);
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    if (!item.workingStatusPreserved || !item.stagedIndexPreserved) throw new Error('Working tree or staging changed during backup: ' + candidate.root);
    console.log('BACKUP_OK=' + JSON.stringify({ root: candidate.root, bytes: item.bundleBytes, untracked: untracked.length }));
  }
  manifest.completedAt = new Date().toISOString();
  manifest.fullWorkspacePortable = false;
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(workspace, 'artifacts/upstream-ui/portable-dirty-tree-backup.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('BACKUP_MANIFEST=' + path.join(destination, 'manifest.json'));
})().catch(error => { console.error(error.message); console.error('Partial backup retained at ' + destination); process.exitCode = 1; });
