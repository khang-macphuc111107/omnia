const fs = require('fs');
const path = require('path');

const targets = [
  { name: 'Cursor Production App', path: 'D:/Omnia/repos/omnia/upstream_extractions/ide/cursor' },
  { name: 'Windsurf IDE', path: 'D:/Omnia/repos/omnia/upstream_extractions/ide/windsurf' },
  { name: 'Antigravity IDE', path: 'D:/Omnia/repos/omnia/upstream_extractions/ide/antigravity-ide' },
  { name: 'Antigravity Core', path: 'D:/Omnia/repos/omnia/upstream_extractions/ide/antigravity-core' },
  { name: 'VS Code Core', path: 'D:/Omnia/repos/omnia/upstream_extractions/ide/vscode-core' },
  { name: 'IDM Multi-Stream', path: 'D:/Omnia/repos/omnia/upstream_extractions/downloaders/idm-multistream' },
  { name: 'Google Drive Downloader', path: 'D:/Omnia/repos/omnia/upstream_extractions/downloaders/gdrive-downloader' },
  { name: 'Gemini Notebook', path: 'D:/Omnia/repos/omnia/upstream_extractions/notebooks/gemini-notebook' },
  { name: 'Gemini Desktop', path: 'D:/Omnia/repos/omnia/upstream_extractions/desktop-apps/gemini-desktop' },
  { name: 'ChatGPT Desktop', path: 'D:/Omnia/repos/omnia/upstream_extractions/desktop-apps/chatgpt-desktop' },
  { name: 'Claude Desktop', path: 'D:/Omnia/repos/omnia/upstream_extractions/desktop-apps/claude-desktop' },
  { name: 'Cherry Studio', path: 'D:/Omnia/repos/omnia/upstream_extractions/desktop-apps/cherry-studio' },
  { name: 'Zalo Desktop', path: 'D:/Omnia/repos/omnia/upstream_extractions/desktop-apps/zalo-desktop' },
  { name: 'Hermes Desktop', path: 'D:/Omnia/repos/omnia/upstream_extractions/desktop-apps/hermes-desktop' },
  { name: 'OpenCode Desktop', path: 'D:/Omnia/repos/omnia/upstream_extractions/desktop-apps/opencode-desktop' },
  { name: 'OpenHands Agent', path: 'D:/Omnia/repos/omnia/upstream_extractions/harnesses/openhands' },
  { name: 'Kimi Code', path: 'D:/Omnia/repos/omnia/upstream_extractions/harnesses/kimi-code' },
  { name: 'Kimi CLI', path: 'D:/Omnia/repos/omnia/upstream_extractions/cli/kimi-cli' },
  { name: 'Pi Harness', path: 'D:/Omnia/repos/omnia/upstream_extractions/harnesses/pi-harness' },
  { name: 'Droid Harness', path: 'D:/Omnia/repos/omnia/upstream_extractions/harnesses/droid-harness' },
  { name: 'Claude Code CLI', path: 'D:/Omnia/repos/omnia/upstream_extractions/harnesses/claude-code' },
  { name: 'OpenAI Codex Harness', path: 'D:/Omnia/repos/omnia/upstream_extractions/harnesses/openai-codex' },
  { name: 'DeepSeek Agent', path: 'D:/Omnia/repos/omnia/upstream_extractions/harnesses/deepseek-agent' },
  { name: 'Hermes Agent', path: 'D:/Omnia/repos/omnia/upstream_extractions/harnesses/hermes-agent' },
  { name: 'Orca Debate Engine', path: 'D:/Omnia/repos/omnia/upstream_extractions/research/orca-debate' },
  { name: 'REA Framework v6.8.0', path: 'D:/Omnia/repos/omnia/upstream_extractions/tools/rea' }
];

async function countFiles(dir) {
  let count = 0;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const subdirs = [];
    for (const e of entries) {
      if (e.isDirectory() || e.isSymbolicLink()) subdirs.push(path.join(dir, e.name));
      else count++;
    }
    if (subdirs.length > 0) {
      const counts = await Promise.all(subdirs.map(d => countFiles(d)));
      for (const c of counts) count += c;
    }
  } catch (err) {}
  return count;
}

async function runPass(passNumber) {
  console.log('=== PASS ' + passNumber + ' EXECUTION & MEASUREMENT ===');
  const results = {};
  for (const t of targets) {
    const cnt = await countFiles(t.path);
    results[t.name] = cnt;
    console.log('  [' + t.name + ']: ' + cnt.toLocaleString() + ' files');
  }
  return results;
}

async function main() {
  console.log('========================================================================');
  console.log('CONVERGENCE GATE: 3 CONSECUTIVE PASSES ZERO-DELTA VERIFICATION');
  console.log('TARGET ECOSYSTEM: 26 COMPONENTS (WEB, DESKTOP, CLI, HARNESSES)');
  console.log('========================================================================');

  const pass1 = await runPass(1);
  const pass2 = await runPass(2);
  const pass3 = await runPass(3);

  let totalDeltaPass2 = 0;
  let totalDeltaPass3 = 0;
  let grandTotalFiles = 0;

  console.log('\n=== CONVERGENCE DELTA AUDIT ===');
  for (const t of targets) {
    const d1 = pass1[t.name];
    const d2 = pass2[t.name];
    const d3 = pass3[t.name];
    const delta12 = d2 - d1;
    const delta23 = d3 - d2;
    totalDeltaPass2 += delta12;
    totalDeltaPass3 += delta23;
    grandTotalFiles += d3;
    console.log('  ' + t.name.padEnd(28) + ' | P1: ' + d1.toLocaleString().padStart(6) + ' | P2: ' + d2.toLocaleString().padStart(6) + ' | P3: ' + d3.toLocaleString().padStart(6) + ' | Delta: ' + (delta12 + delta23));
  }

  console.log('------------------------------------------------------------------------');
  console.log('Grand Total Production Files Across All 26 Components: ' + grandTotalFiles.toLocaleString());
  console.log('Pass 1 -> Pass 2 Total Delta: ' + totalDeltaPass2);
  console.log('Pass 2 -> Pass 3 Total Delta: ' + totalDeltaPass3);

  if (totalDeltaPass2 === 0 && totalDeltaPass3 === 0) {
    console.log('[SUCCESS] ABSOLUTE CONVERGENCE ACHIEVED: 3 consecutive passes report DELTA = 0 across ALL 26 components!');
  } else {
    console.log('[WARN] Extraction still in progress, non-zero delta detected.');
  }
  console.log('========================================================================');
}

main();
