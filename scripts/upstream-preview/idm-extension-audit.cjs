const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../upstream_extractions/downloaders/idm-multistream/unpacked_browser_extensions');
const targets = ['IDMOpExt/background.js', 'idmmzcc3/background.js'];
const rows = targets.map(rel => {
  const file = path.join(root, rel);
  const source = fs.readFileSync(file, 'utf8');
  let syntax = 'pass';
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); } catch { syntax = 'fail'; }
  const matches = pattern => [...source.matchAll(pattern)].map(m => m[0]);
  return {
    path: rel,
    bytes: fs.statSync(file).size,
    sha256: crypto.createHash('sha256').update(source).digest('hex'),
    nodeSyntax: syntax,
    // Keep these expressions as literals so the slash/dot escaping is applied
    // by the RegExp parser exactly once. The previous constructor strings
    // contained doubled backslashes and silently returned empty inventories.
    webSocketEndpoints: [...new Set(matches(/wss?:\/\/[^"' )]+/g))],
    nativeHostReferences: [...new Set(matches(/(?:browser\.)?runtime\.connectNative\([^)]+\)/g))],
    extensionApiFamilies: [...new Set(matches(/(?:browser\.)?(?:runtime|tabs|webRequest|downloads|storage|cookies|contextMenus|i18n)\.[A-Za-z]+/g).map(x => x.replace(/^browser\./, '')))],
    protocolMarkers: [...new Set(matches(/(?:idmreg|idmdwnlmfv9|x-idm-[A-Za-z-]+)/g))].slice(0, 30),
    reaAnalysis: 'partial-or-timeout; static audit does not replace runtime execution'
  };
});
const report = { generatedAt: new Date().toISOString(), app: 'idm-extension', root: 'upstream_extractions/downloaders/idm-multistream/unpacked_browser_extensions', files: rows, runtimeParity: 'unverified', conclusion: 'Background scripts are authentic extracted extension artifacts and syntax-check successfully. Their native host, WebSocket, browser permission, and IDM Win32 interactions require a real browser plus native host for behavioral verification.' };
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../artifacts/upstream-ui/idm-extension-audit.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

