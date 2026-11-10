const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const assetsDir = 'D:/Omnia/downloads/cursor_installed/resources/app/molten/dist/renderer/assets';
const outBase = 'D:/Omnia/repos/omnia/upstream_extractions/ide/cursor/extracted_unbundled_ui';
fs.mkdirSync(outBase, { recursive: true });

const targetFiles = [
  'composer-registry-DbheOXau.js',
  'chat-pane-CN4efcMK.js',
  'canvas-pane-DS7Dmjib.js',
  'agent-actions-DR3LnkyB.js',
  'agent-transcript-tool-views-Bl1dHgze.js',
  'AgentConversationContext-Byd4rJn9.js',
  'AgentTranscriptConnectScmCard-B-JNcPkI.js',
  'auth-store-CxuRL-Xc.js',
  'apps-panel-store-KAZ9xNOR.js',
  'account-store-BkTz2Brp.js',
  'browser-store-BriY_Tqx.js',
  'CodeBlock-B-Urr8-l.js',
  'CodeBlockChrome-CSjwFiPz.js',
  'codeEditorWidget-BcD_-kYd.js'
];

console.log('Unbundling Cursor Core UI Components with webcrack...');
let count = 0;
for (const file of targetFiles) {
  const fullPath = path.join(assetsDir, file);
  if (!fs.existsSync(fullPath)) {
    console.log('Skipping missing:', file);
    continue;
  }
  const cleanName = file.replace(/-[A-Za-z0-9_-]+\.js$/, '');
  const outDir = path.join(outBase, cleanName);
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const cmd = 'cmd /c npx webcrack "' + fullPath + '" -o "' + outDir + '" -f --no-jsx';
    execSync(cmd, { stdio: 'inherit' });
    console.log('[OK] Extracted ' + cleanName);
    count++;
  } catch (err) {
    console.log('[FAIL] ' + cleanName + ': ' + err.message);
  }
}
console.log('Finished unbundling ' + count + ' core Cursor UI components.');
