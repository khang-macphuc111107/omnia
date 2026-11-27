// Settings view — pure helpers (no DOM, no storage access). Unit-tested in ui/tests/settings.test.js.

/** Chat sessions are stored under omnia.ui.chat.<sessionId> (spec §6.1). */
export const CHAT_PREFIX = 'omnia.ui.chat.';

export const THEMES = ['dark', 'light', 'system'];
export const DENSITIES = ['comfortable', 'compact'];
export const LANGUAGE_OPTIONS = [
  { id: 'vi', label: 'Tiếng Việt' },
  { id: 'en', label: 'English' }
];

/** [dark|light] halves used to paint the theme preview swatches: [sidebar theme, main theme]. */
export const THEME_SWATCH = { dark: ['dark', 'dark'], light: ['light', 'light'], system: ['dark', 'light'] };

/** Keyboard shortcuts documented in the table. `range` shows "first … last". */
export const SHORTCUTS = [
  { id: 'palette', keys: ['Ctrl K'] },
  { id: 'sidebar', keys: ['Ctrl B'] },
  { id: 'inspector', keys: ['Ctrl .'] },
  { id: 'views', keys: ['Alt 1', 'Alt 5'], range: true },
  { id: 'send', keys: ['Ctrl Enter'] },
  { id: 'theme', keys: ['Alt T'] },
  { id: 'escape', keys: ['Esc'] }
];

export function utf8Length(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

/**
 * Accounting for locally stored chat data. `records` is [{ key, raw }] where raw is the
 * stored JSON string. Sessions are counted only when they hold at least one message
 * (a draft alone is data, but not a conversation).
 */
export function summarizeLocalChat(records) {
  const out = { records: 0, sessions: 0, messages: 0, bytes: 0, unreadable: 0 };
  for (const record of records || []) {
    if (!record || typeof record.key !== 'string') continue;
    const raw = typeof record.raw === 'string' ? record.raw : '';
    out.records += 1;
    out.bytes += utf8Length(record.key) + utf8Length(raw);
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      out.unreadable += 1;
      continue;
    }
    const count = data && Array.isArray(data.messages) ? data.messages.length : 0;
    if (count > 0) {
      out.sessions += 1;
      out.messages += count;
    }
  }
  return out;
}

/** The JSON document written by "Xuất JSON". Unparseable records are kept verbatim as `raw`. */
export function buildExport(records, now = new Date()) {
  const sessions = (records || [])
    .filter((record) => record && typeof record.key === 'string' && record.key.startsWith(CHAT_PREFIX))
    .map((record) => {
      const sessionId = record.key.slice(CHAT_PREFIX.length);
      try {
        return { sessionId, data: JSON.parse(record.raw) };
      } catch {
        return { sessionId, raw: String(record.raw ?? '') };
      }
    })
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return { app: 'omnia-studio', kind: 'local-chat', version: 1, exportedAt: now.toISOString(), sessions };
}

/** omnia-local-chat-YYYYMMDD.json in the user's local calendar day. */
export function exportFileName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `omnia-local-chat-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.json`;
}

/**
 * Rows for the diagnostics list from a /api/health body. `kind` tells the view how to
 * format: text | mono | num | bytes | pair (value = [a, b]). Empty when there is no health yet.
 */
export function diagnosticRows(health, host = '') {
  if (!health) return host ? [{ id: 'host', kind: 'mono', value: host }] : [];
  return [
    { id: 'host', kind: 'mono', value: host },
    { id: 'engine', kind: 'text', value: health.engine },
    { id: 'compiler', kind: 'mono', value: health.compiler },
    { id: 'crateCount', kind: 'num', value: health.crateCount },
    { id: 'pid', kind: 'num', value: health.pid },
    { id: 'workingSet', kind: 'bytes', value: health.workingSetBytes },
    { id: 'binary', kind: 'bytes', value: health.binaryBytes },
    { id: 'skillsPeers', kind: 'pair', value: [health.skillCount, health.peerCount] },
    { id: 'rustFiles', kind: 'num', value: health.rustFiles }
  ].filter((row) => host || row.id !== 'host');
}

/** connection.status → chip presentation. */
export function connectionMeta(status) {
  switch (status) {
    case 'online':
      return { variant: 'ok', icon: 'check-circle', labelKey: 'settings.connOnline' };
    case 'offline':
      return { variant: 'danger', icon: 'wifi-off', labelKey: 'settings.connOffline' };
    default:
      return { variant: 'warn', icon: 'clock', labelKey: 'settings.connConnecting' };
  }
}

/** Palette → section ids, shared by the commands and the view. */
export const SECTIONS = ['appearance', 'language', 'keys', 'diag', 'local'];
export function sectionDomId(section) {
  return `settings-${section}`;
}
