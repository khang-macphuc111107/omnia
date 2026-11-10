// Independent read-only proof, run after the native audit has stopped its service.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '../..');
const input = path.resolve(process.argv[2] || path.join(root, 'artifacts/upstream-ui/opencode-native-desktop-audit.json'));
const runtime = JSON.parse(fs.readFileSync(input, 'utf8'));
if (!runtime.finishedAt || runtime.cleanup.service.exitCode !== 0) throw new Error('Native audit must finish and stop its owned service first.');
const file = path.join(runtime.scratch, 'data/opencode/opencode-local.db');
const db = new DatabaseSync(file, { readOnly: true });
let report;
try {
  const session = db.prepare('SELECT id,title,directory,idle_outcome FROM session_v2 WHERE id=?').get(runtime.sessionId);
  const messages = db.prepare('SELECT id,type,data FROM session_message WHERE session_id=? ORDER BY seq').all(runtime.sessionId).map(r => ({ id: r.id, type: r.type, data: JSON.parse(r.data) }));
  const assistants = messages.filter(m => m.type === 'assistant');
  const tools = assistants.flatMap(m => m.data.content || []).filter(c => c.type === 'tool');
  const text = assistants.flatMap(m => m.data.content || []).filter(c => c.type === 'text').map(c => c.text);
  const outcomes = messages.filter(m => m.type === 'idle').map(m => m.data.outcome);
  const checks = {
    stableNamedSession: session?.id === runtime.sessionId && session?.title === 'Omnia OpenCode native replay',
    originalAndRecoveredResponses: text.filter(t => t === 'OMNIA_OPENCODE_DESKTOP_OK').length >= 2,
    interruptionPersisted: outcomes.includes('interrupted'),
    authenticationErrorPersisted: assistants.some(m => m.data.error?.type === 'provider.auth' && m.data.error?.status === 401),
    shellCompletedWithExitZero: tools.some(t => t.name === 'shell' && t.state?.status === 'completed' && t.state?.metadata?.exit === 0 && JSON.stringify(t.state.content).includes('OMNIA_OPENCODE_SHELL_OK')),
    toolRoundtripResponsePersisted: text.includes('OMNIA_OPENCODE_TOOL_ROUNDTRIP_OK'),
  };
  report = { generatedAt: new Date().toISOString(), input, sqlite: { file, readOnly: true }, session,
    messageCount: messages.length, userTexts: messages.filter(m => m.type === 'user').map(m => m.data.text),
    assistantTexts: text, outcomes, tools, checks };
} finally { db.close(); }
fs.writeFileSync(path.join(root, 'artifacts/upstream-ui/opencode-native-disk-audit.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ session: report.session, checks: report.checks }, null, 2));
process.exitCode = Object.values(report.checks).every(Boolean) ? 0 : 1;
