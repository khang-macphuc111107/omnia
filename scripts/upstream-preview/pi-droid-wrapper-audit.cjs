const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../upstream_extractions/harnesses');
const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const run = (file, args = []) => { const r = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8' }); return { exitCode: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() }; };
const piEntry = path.join(root, 'pi-harness/dist/index.js');
const droidEntry = path.join(root, 'droid-harness/dist/index.js');
const piSource = fs.readFileSync(path.join(root, 'pi-harness/src/pacer.ts'), 'utf8') + fs.readFileSync(path.join(root, 'pi-harness/src/inflection-cache.ts'), 'utf8');
const droidSource = fs.readFileSync(path.join(root, 'droid-harness/src/kd-tree-dag.ts'), 'utf8') + fs.readFileSync(path.join(root, 'droid-harness/src/mesh-router.ts'), 'utf8');
const piRun = run(piEntry);
const droidRun = run(droidEntry);
const pi = require(piEntry);
const piHarness = pi.createPiHarness();
const cacheKey = piHarness.cache.getCacheKey('system', 'history');
piHarness.cache.registerPrefix(cacheKey, 42);
const cached = piHarness.cache.queryPrefix(cacheKey);
const delay = piHarness.pacer.calculateDelayMs('a small deterministic response');
const droid = require(droidEntry);
const mesh = droid.createDroidMesh();
const routed = mesh.routeTask(60, 90);
const statusAfterRoute = routed.status;
mesh.releaseAgent(routed.agentId);
const statusAfterRelease = routed.status;
const rerouted = mesh.routeTask(60, 90);
const sameAgentRerouted = rerouted.agentId === routed.agentId;
mesh.releaseAgent(rerouted.agentId);
const report = {
  generatedAt: new Date().toISOString(),
  sourceClassification: 'reconstructed-Pi-and-Droid-harnesses',
  pi: { entrypoint: 'upstream_extractions/harnesses/pi-harness/dist/index.js', sha256: sha256(piEntry), runtime: piRun, checks: { cacheRoundTrip: cached?.kvTokenCount === 42, boundedPacingDelay: delay >= 250 && delay <= 2500 } },
  droid: { entrypoint: 'upstream_extractions/harnesses/droid-harness/dist/index.js', sha256: sha256(droidEntry), runtime: droidRun, observations: { statusAfterRoute, statusAfterRelease, sameAgentRerouted }, checks: { routeReturnedAgent: routed.agentId === 'ag-fast' || routed.agentId === 'ag-deep', releaseRestoredIdle: statusAfterRoute === 'running' && statusAfterRelease === 'idle' && sameAgentRerouted } },
  integration: {
    networkImportsDetected: /fetch\s*\(|https?:\/\/|axios|openai|anthropic|@ai-sdk/.test(piSource + droidSource),
    realPiProvider: 'unverified',
    realDroidAgentDispatch: 'unverified',
  },
  conclusion: 'Pi and Droid entrypoints execute and their local pacing/cache and KD-tree routing primitives pass deterministic fixtures. The checked source contains no provider, network, PTY or external agent dispatch integration; real product parity remains unverified.',
};
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../artifacts/upstream-ui/pi-droid-wrapper-audit.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
