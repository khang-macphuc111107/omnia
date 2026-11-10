const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const workspace = path.resolve(__dirname, '../..');
const root = path.join(workspace, 'upstream_extractions/harnesses/opencode');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const repair = process.argv.includes('--repair');
const hardlinkFallback = process.argv.includes('--hardlink-fallback');
const backup = path.join(workspace, '.toolchains/opencode-symlink-backup', String(Date.now()));
const rows = git('ls-files', '-s', '-z').split('\0').filter((entry) => entry.startsWith('120000 ')).map((entry) => {
  const [meta, name] = entry.split('\t');
  const oid = meta.split(' ')[1];
  const target = git('cat-file', 'blob', oid);
  const file = path.join(root, name);
  const resolved = path.resolve(path.dirname(file), target);
  const row = { path: name, target, indexBlob: oid };
  if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved)) return { ...row, status: 'target-missing-or-outside-repository' };
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return { ...row, status: fs.realpathSync(file) === fs.realpathSync(resolved) ? 'correct-symlink' : 'different-symlink-preserved' };
  const targetStat = fs.statSync(resolved);
  if (stat.isFile() && stat.nlink > 1 && stat.dev === targetStat.dev && stat.ino === targetStat.ino) return { ...row, status: 'existing-materialized-hardlink' };
  if (!stat.isFile() || fs.readFileSync(file, 'utf8').trimEnd() !== target.trimEnd()) return { ...row, status: 'local-edit-preserved' };
  if (!repair) return { ...row, status: 'pointer-file-needs-repair' };
  const saved = path.join(backup, name);
  fs.mkdirSync(path.dirname(saved), { recursive: true });
  fs.renameSync(file, saved);
  try {
    fs.symlinkSync(target, file, 'file');
    return { ...row, status: 'repaired', backup: path.relative(workspace, saved), targetSha256: crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex') };
  } catch (error) {
    if (hardlinkFallback && error.code === 'EPERM') {
      try {
        fs.linkSync(resolved, file);
        return { ...row, status: 'materialized-hardlink', symlinkError: error.message, backup: path.relative(workspace, saved), targetSha256: crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex') };
      } catch (fallbackError) { row.fallbackError = fallbackError.message; }
    }
    fs.renameSync(saved, file);
    return { ...row, status: 'repair-failed-original-restored', error: error.message };
  }
});
const complete = rows.every((r) => ['correct-symlink', 'repaired'].includes(r.status));
if (repair && complete) git('config', '--local', 'core.symlinks', 'true');
const report = { generatedAt: new Date().toISOString(), revision: git('rev-parse', 'HEAD').trim(), repairRequested: repair, hardlinkFallback, allTrackedSymlinksCorrect: complete, allTargetsAvailable: rows.every((r) => ['correct-symlink', 'repaired', 'materialized-hardlink', 'existing-materialized-hardlink'].includes(r.status)), conclusion: 'Hardlinks, when explicitly requested, materialize upstream file bytes for a Windows build and are a local checkout adaptation, not restored symlink semantics. Original pointer files are preserved in backups.', rows };
fs.writeFileSync(path.join(workspace, 'artifacts/upstream-ui/opencode-symlink-repair.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
