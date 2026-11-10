const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workspace = path.resolve(__dirname, '../..');
const root = path.join(workspace, 'upstream_extractions');
const skip = new Set(['node_modules', '.git', 'target', 'dist', 'build', 'chrome_canary_profile', 'app-unpacked', 'app.asar.unpacked']);
const embedded = [];
const gitlinks = [];
const omitted = [];
function walk(dir, depth = 0) {
  if (depth > 5) { omitted.push({ path: path.relative(workspace, dir), reason: 'depth-limit' }); return; }
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.name === '.git') {
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      embedded.push({ path: path.relative(workspace, p).replaceAll('\\', '/'), type: 'git-metadata', kind: st.isDirectory() ? 'directory' : 'gitfile', bytes: st.size });
      continue;
    }
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) {
      const target = (() => { try { return fs.readlinkSync(p); } catch { return null; } })();
      const targetGit = (() => { try { return target && fs.existsSync(path.resolve(dir, target, '.git')); } catch { return false; } })();
      embedded.push({ path: path.relative(workspace, p).replaceAll('\\', '/'), type: 'symlink-or-junction', target, targetContainsGitMetadata: targetGit });
      continue;
    }
    if (skip.has(entry.name)) { omitted.push({ path: path.relative(workspace, p), reason: 'excluded-directory' }); continue; }
    if (entry.isDirectory()) walk(p, depth + 1);
  }
}
walk(root);
const submodule = spawnSync('git', ['submodule', 'status', '--recursive'], { cwd: workspace, encoding: 'utf8' });
const index = spawnSync('git', ['ls-files', '--stage', '-z'], { cwd: workspace, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (index.error || index.status !== 0) throw new Error(`Cannot enumerate Git index: ${index.error || index.stderr}`);
for (const line of index.stdout.split('\0').filter(Boolean)) {
  const match = line.match(/^160000 ([0-9a-f]+) ([0-3])\t(.*)$/s);
  if (match) gitlinks.push({ revision: match[1], stage: Number(match[2]), path: match[3] });
}
const dirty = spawnSync('git', ['status', '--short'], { cwd: workspace, encoding: 'utf8' });
const report = {
  generatedAt: new Date().toISOString(),
  workspace,
  inventoryCoverage: 'partial-depth-and-directory-limited',
  omitted,
  gitCommands: { index: { exitCode: index.status, stderr: index.stderr }, submodule: { exitCode: submodule.status, stdout: submodule.stdout, stderr: submodule.stderr }, status: { exitCode: dirty.status, stderr: dirty.stderr } },
  embeddedArtifacts: embedded,
  embeddedCount: embedded.length,
  gitlinks,
  dirtyEntries: (dirty.stdout || '').split(/\r?\n/).filter(Boolean),
  backupLimitations: {
    gitlinksDoNotContainWorkingTreeChanges: gitlinks.length > 0,
    junctionsPointingAtGitTrees: embedded.filter(x => x.targetContainsGitMetadata).length,
    junctionTargetsAreExternalState: embedded.some(x => x.type === 'symlink-or-junction'),
    intentionalDirtyTreesPreserved: true,
  },
  conclusion: 'A portable backup must preserve gitlink revisions separately from dirty embedded working trees and junction targets. This inventory is metadata evidence; it does not copy, reset or delete any embedded tree.',
};
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../artifacts/upstream-ui/portable-embedded-tree-audit.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
