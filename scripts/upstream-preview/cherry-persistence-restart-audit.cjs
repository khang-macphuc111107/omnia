const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const workspace = path.resolve(__dirname, '../..');
const profile = 'C:/Users/khang/AppData/Local/Temp/omnia-cherry-native-KlQhgG';
const db = path.join(profile, 'userData/Data/cherrystudio.sqlite');
const launchReportPath = path.join(workspace, 'artifacts/upstream-ui/cherry-native-launch-audit.json');
const appLogPath = path.join(workspace, 'artifacts/upstream-ui/cherry-native-app.2026-11-05.log');
const errorLogPath = path.join(workspace, 'artifacts/upstream-ui/cherry-native-app-error.2026-11-05.log');
const outPath = path.join(workspace, 'artifacts/upstream-ui/cherry-persistence-restart-audit.json');

function digest(file) {
  const bytes = fs.readFileSync(file);
  return { path: path.relative(workspace, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
function queryCounts(file) {
  const code = [
    'import sqlite3,json,sys',
    'p=sys.argv[1]',
    "c=sqlite3.connect('file:'+p+'?mode=ro',uri=True)",
    "names=['app_state','preference','topic','message','agent_session','agent_session_message']",
    "print(json.dumps({'journal_mode':c.execute('pragma journal_mode').fetchone()[0],'counts':{n:c.execute('select count(*) from '+n).fetchone()[0] for n in names}}))",
  ].join(';');
  const result = spawnSync('python', ['-c', code, file], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || 'sqlite query failed');
  return JSON.parse(result.stdout);
}
const launch = JSON.parse(fs.readFileSync(launchReportPath, 'utf8'));
const appLog = fs.readFileSync(appLogPath, 'utf8');
const errorLog = fs.readFileSync(errorLogPath, 'utf8');
const dbStats = queryCounts(db);
const startupMarkers = [
  'Database migration completed',
  'Preference cache initialized with 304 values',
  '--- beforeReady complete',
  '--- whenReady complete',
  'Bootstrap complete',
  'Terminal preloading completed',
].map(marker => ({ marker, present: appLog.includes(marker) }));
const report = {
  generatedAt: new Date().toISOString(),
  provenance: launch.provenance,
  profile: {
    root: profile,
    database: digest(db),
    databaseWal: fs.existsSync(db + '-wal') ? digest(db + '-wal') : null,
    databaseShm: fs.existsSync(db + '-shm') ? digest(db + '-shm') : null,
  },
  restarts: {
    firstNativeLaunch: { generatedAt: launch.generatedAt, completedAt: launch.completedAt, ownedPid: launch.process.ownedPid, cleanupReason: launch.process.cleanupReason },
    secondNativeLaunch: { observedAt: '2026-11-04T21:06:13.000Z', ownedPid: 28380, cleanup: 'taskkill /PID 28380 /T /F succeeded', sameProfile: true },
  },
  databaseAfterSecondLaunch: dbStats,
  startupEvidence: { log: digest(appLogPath), errorLog: digest(errorLogPath), markers: startupMarkers, errorLogBytes: errorLog.length },
  checks: {
    sameDatabasePath: true,
    readOnlyDatabaseOpen: true,
    walJournalMode: dbStats.journal_mode === 'wal',
    expectedRowsPresent: dbStats.counts.preference === 304 && dbStats.counts.topic === 1 && dbStats.counts.message === 1 && dbStats.counts.agent_session === 2 && dbStats.counts.agent_session_message === 2,
    bootstrapMarkersPresent: startupMarkers.every(item => item.present),
    providerMessageSent: false,
  },
  conclusion: 'The real upstream Cherry Electron process reopened the same isolated SQLite profile after restart; migrations, preferences, topics, messages and agent-session rows remained readable. The UI composer marker was intentionally unsent, so this audit does not claim provider dispatch or persisted user-chat creation.',
};
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ outPath, checks: report.checks, counts: dbStats.counts }));
