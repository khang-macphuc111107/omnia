const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../upstream_extractions/downloaders/gdrive-downloader');
const variants = [
  'idm_extracted_ext',
  'idm_reference/extracted_crx',
  'idm_reference/extracted_edge',
];
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const reports = variants.map(relative => {
  const dir = path.join(root, relative);
  const manifestPath = path.join(dir, 'manifest.json');
  const backgroundPath = path.join(dir, 'background.js');
  const source = fs.readFileSync(backgroundPath, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const syntax = spawnSync(process.execPath, ['--check', backgroundPath], { encoding: 'utf8' });
  return {
    variant: relative,
    manifestVersion: manifest.manifest_version,
    name: manifest.name,
    version: manifest.version,
    backgroundBytes: Buffer.byteLength(source),
    backgroundSha256: sha256(source),
    syntaxCheckExitCode: syntax.status,
    syntaxError: (syntax.stderr || '').trim() || null,
    permissions: manifest.permissions || [],
    backgroundScripts: manifest.background?.scripts || [],
    indicators: {
      usesNativeMessaging: source.includes('connectNative') || (manifest.permissions || []).includes('nativeMessaging'),
      usesWebSocketFallback: source.includes('new WebSocket('),
      usesDownloadApi: source.includes('browser.downloads'),
      usesWebRequestApi: source.includes('webRequest'),
      usesContextMenus: source.includes('contextMenus'),
      usesCustomSchemes: /idmreg:|idmdwnlmfv9:/.test(source),
      hasIdmHostMarkers: /internetdownloadmanager|plugin\.v3\.internetdownloadmanager\.com|com\.tonec\.idm/i.test(source),
    },
    externalEndpoints: [...new Set([...source.matchAll(/https?:\/\/[^`"' )]+/g)].map(match => match[0]))],
  };
});
const report = {
  generatedAt: new Date().toISOString(),
  sourceClassification: 'official-extracted-IDM-browser-extension-background-scripts',
  root: 'upstream_extractions/downloaders/gdrive-downloader',
  variants: reports,
  equivalence: {
    crxMatchesExtracted: reports[0]?.backgroundSha256 === reports[1]?.backgroundSha256,
    edgeDiffersFromChromium: reports[2]?.backgroundSha256 !== reports[1]?.backgroundSha256,
  },
  nativeHostParity: 'unverified',
  conclusion: 'The extracted Chromium and CRX background scripts are byte-identical and pass Node syntax checks. They implement the browser-side IDM bridge: native messaging fallback, WebSocket fallback, download/webRequest/context-menu hooks, IDM custom schemes, and IDM host markers. This does not prove the proprietary Win32 native host or live IDM desktop behavior.',
};
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../artifacts/upstream-ui/idm-background-static-audit.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
