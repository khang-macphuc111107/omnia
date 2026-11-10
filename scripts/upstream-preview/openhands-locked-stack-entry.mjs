import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Use upstream orchestration and its supported startAgentServer embedding hook.
// Environments must first be installed with upstream uv.lock and --locked.
const canvas = process.env.OMNIA_OPENHANDS_CANVAS;
const sdk = process.env.OH_AGENT_SERVER_LOCAL_PATH;
if (!canvas || !sdk || !process.env.OMNIA_OPENHANDS_STACK_READY) throw new Error('Missing isolated launcher environment');
const { main, spawnService, buildAgentServerAutomationEnv } = await import(pathToFileURL(path.join(canvas, 'scripts/dev-with-automation.mjs')));
const { buildSafeDevConfig, buildAgentServerEnv } = await import(pathToFileURL(path.join(canvas, 'scripts/dev-safe.mjs')));
const { config, agentServerReady } = await main({
  bannerTitle: 'Omnia upstream Canvas with locked source backends',
  staticMode: true, staticDir: path.join(canvas, 'build'), marsWebBridge: false,
  skipNpmCheck: true, agentServerReadyTimeoutMs: 180000,
  startAgentServer(config) {
    const safe = buildSafeDevConfig(config.canvasPath, { ...process.env,
      OH_CANVAS_SAFE_STATE_DIR: config.stateDir,
      OH_CANVAS_SAFE_BACKEND_PORT: String(config.agentServerPort),
      OH_CANVAS_SAFE_VSCODE_PORT: String(config.vscodePort), TMUX_TMPDIR: config.tmuxTmpDir });
    spawnService('agent-server', path.join(sdk, '.venv/Scripts/python.exe'),
      ['-m', 'openhands.agent_server', '--import-modules', 'canvas_ui_tool', '--host', '127.0.0.1', '--port', String(config.agentServerPort)],
      { cwd: safe.workspacesPath, env: { ...buildAgentServerEnv(safe), ...buildAgentServerAutomationEnv(config),
        OH_SESSION_API_KEYS_0: config.sessionApiKey, LOG_JSON: 'true' } });
  },
});
fs.writeFileSync(process.env.OMNIA_OPENHANDS_STACK_READY, JSON.stringify({
  agentServerReady, ingressPort: config.ingressPort, agentServerPort: config.agentServerPort,
  automationPort: config.autoBackendPort, stateDir: config.stateDir,
}) + '\n');
