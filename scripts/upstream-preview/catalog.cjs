const path = require('node:path');
const base = path.resolve(__dirname, '../../upstream_extractions');
const app = (id, port, root, entry, kind, limitation, sourceClassification = 'upstream-asset-tree') => ({
  id, port, root: path.join(base, root), entry, kind, limitation, sourceClassification,
});
module.exports = [
  app('cursor', 3998, 'ide/cursor/cursor-production-app/out', 'vs/code/electron-sandbox/workbench/workbench.html', 'electron', 'Requires the original Electron preload, IPC and main process; HTTP asset delivery is not a running IDE.'),
  app('windsurf', 3996, 'ide/windsurf/windsurf-production-app/out', 'vs/code/electron-browser/workbench/workbench.html', 'electron', 'Requires original Electron preload, IPC and backend.'),
  app('antigravity', 3989, 'ide/antigravity-ide/out', 'vs/code/electron-browser/workbench/workbench.html', 'electron', 'Requires original Electron host and ConnectRPC services.'),
  app('agy-desktop', 3988, 'desktop-apps/agy-desktop/app/out', 'vs/code/electron-browser/workbench/workbench.html', 'electron', 'Requires the original Antigravity desktop host, preload, IPC and services.', 'reconstructed-shell-plus-upstream-assets'),
  app('chatgpt', 3995, 'desktop-apps/chatgpt-desktop/app-unpacked/webview', 'index.html', 'electron', 'Requires desktop bridge and authenticated remote services.', 'reconstructed-shell-plus-upstream-assets'),
  app('claude', 3994, 'desktop-apps/claude-desktop/app-unpacked/ion-dist', 'index.html', 'electron', 'Requires original desktop runtime and services.'),
  app('zalo', 3993, 'desktop-apps/zalo-desktop/app-unpacked/pc-dist', 'index.html', 'electron', 'Requires original desktop bridge and authenticated services.'),
  app('idm', 3999, 'downloaders/idm-multistream/unpacked_browser_extensions/IDMGCExt', 'captured.html', 'extension', 'Original browser-extension page only. Requires extension APIs and IDM native host; this is not the Win32 IDM GUI or recovered native source.'),
  app('hermes', 3992, 'harnesses/hermes-agent/apps/desktop/dist', 'index.html', 'electron', 'Official Hermes desktop renderer requires its Electron main/preload and PM-managed canonical gateway. Launch desktop-apps/hermes-desktop; HTTP assets alone cannot provide native behavior.', 'upstream-source-repository-with-omnia-launcher'),
  app('opencode', 3991, 'harnesses/opencode/packages/desktop/out/renderer', 'index.html', 'electron', 'Official OpenCode desktop renderer requires its Electron main/preload, MessagePort RPC and canonical CLI service. Launch desktop-apps/opencode-desktop; HTTP assets alone do not provide native behavior.', 'upstream-source-repository-with-omnia-launcher'),
  app('openhands', 3987, 'harnesses/openhands/build', 'index.html', 'build-required', 'Original React Router SPA build; a real Agent Server is still required for agent operations.'),
  app('cherry-studio', 3986, 'desktop-apps/cherry-studio/out/renderer', 'windows/main/index.html', 'build-required', 'Original Electron renderer build; run its main/preload processes for desktop IPC.'),
  app('orca', 3990, 'desktop-apps/orca-desktop', null, 'unverified', 'Only an Omnia reconstructed shell was found. No verified original Orca desktop UI artifact has been identified.', 'reconstructed-shell-no-verified-upstream-assets'),
  app('gdrive-downloader', 3888, 'downloaders/gdrive-downloader/public', 'index.html', 'node', 'Upstream Node downloader UI; runtime server and IDM/native integrations require separate verification.'),
  app('gemini-notebook', 3000, 'notebooks/gemini-notebook/public', 'index.html', 'node', 'Upstream NotebookLM ingestion UI; authenticated Google browser/backend behavior requires separate verification.'),
  app('herdr', 3997, 'desktop-apps/herdr-app', null, 'native', 'Upstream Rust desktop app with bundled herdr-app CLI and herdr-core integration; requires platform build/runtime and desktop session.', 'upstream-source-repository'),
];
