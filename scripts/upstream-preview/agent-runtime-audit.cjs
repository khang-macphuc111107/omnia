const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../upstream_extractions/harnesses');
const hermes = path.join(root, 'hermes-agent');
const help = spawnSync('python', ['run_agent.py', '--help'], { cwd: hermes, encoding: 'utf8', timeout: 30000 });
const pyFiles = fs.readdirSync(path.join(hermes, 'hermes_cli')).filter((x) => x.endsWith('.py'));
const report = { generatedAt: new Date().toISOString(), hermes: { package: JSON.parse(fs.readFileSync(path.join(hermes, 'package.json'))), pythonEntrypoint: 'run_agent.py', pythonFilesInHermesCli: pyFiles.length, help: { exitCode: help.status, stdout: (help.stdout || '').slice(-500), stderr: (help.stderr || '').slice(-1000) }, runtimeParity: 'unverified' }, notes: ['Hermes help is blocked by missing python-dotenv in the host environment.', 'compileall was attempted for hermes_cli/agent/tools; Python generated permission errors while replacing existing __pycache__ files under tools, so this is not treated as a clean compile pass.', 'Provider credentials, agent tools, backend, and interactive CLI behavior remain unverified.'], conclusion: 'Hermes upstream source and entrypoint are present, but dependency installation and runtime behavior are not verified on this host.' };
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../artifacts/upstream-ui/agent-runtime-audit.json'); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
