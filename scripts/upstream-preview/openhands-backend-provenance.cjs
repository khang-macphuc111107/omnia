const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources = ['openhands-agent-sdk', 'openhands-automation'].map(name => {
  const source = path.join(root, 'upstream_extractions/harnesses', name);
  const run = (command, args) => {
    const r = spawnSync(command, args, { cwd: source, windowsHide: true, encoding: 'utf8' });
    return { exitCode: r.status, stdout: r.stdout?.trim(), stderr: r.stderr?.trim(), error: r.error?.message };
  };
  const packages = run(path.join(source, '.venv/Scripts/python.exe'), ['-c',
    'import importlib.metadata as m,json,sys; names=["openhands-sdk","openhands-tools","openhands-workspace","openhands-agent-server","openhands-automation","litellm","uvicorn"]; print(json.dumps({"python":sys.version,"packages":{n:m.version(n) for n in names if next(m.distributions(name=n),None) is not None}},sort_keys=True))']);
  return { name, remote: run('git', ['remote', 'get-url', 'origin']), revision: run('git', ['rev-parse', 'HEAD']),
    trackedChanges: run('git', ['status', '--porcelain', '--untracked-files=no']),
    lock: { path: path.relative(root, path.join(source, 'uv.lock')), bytes: fs.statSync(path.join(source, 'uv.lock')).size, sha256: hash(path.join(source, 'uv.lock')) },
    packages };
});
const uv = path.join(root, 'upstream_extractions/desktop-apps/cherry-studio/resources/binaries/win32-x64/uv.exe');
const report = { generatedAt: new Date().toISOString(), sources,
  uv: { path: path.relative(root, uv), sha256: hash(uv), version: spawnSync(uv, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() },
  installs: [
    { source: 'openhands-agent-sdk', command: 'uv sync --locked --no-dev --package openhands-agent-server --python 3.13', session: 29527, log: 'openhands-agent-sync.log' },
    { source: 'openhands-automation', command: 'uv sync --locked --no-dev --python 3.13', session: 6225, log: 'openhands-automation-sync.log' },
    { source: 'openhands-agent-sdk', command: 'uv sync --locked --no-dev --all-packages --python 3.13', log: 'openhands-sdk-workspace-sync.log' },
  ].map(i => ({ ...i, evidence: 'historical-imported-log', executionReplayed: false, exitCode: null, logSha256: hash(path.join(root, 'artifacts/upstream-ui', i.log)) })),
  notes: ['Python 3.13.18 installed under .toolchains/openhands-python using verified bundled uv.',
    'LiteLLM 1.93.0 compiled its native Rust wheel successfully during locked sync.',
    'Automation lock includes openhands-agent-server 1.19.1 as a dependency; its process here runs only automation. Live agent-server is separately source-built 1.59.0.',
    'Source gitlinks record commits, not portable contents of embedded working trees. Dependencies and compiled artifacts stay local.'] };
fs.writeFileSync(path.join(root, 'artifacts/upstream-ui/openhands-backend-provenance.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
