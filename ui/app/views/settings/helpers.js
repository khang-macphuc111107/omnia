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

/** connection.status → transport reachability chip presentation. */
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

/** Separate service health presentation from transport reachability (AUD-25). */
export function serviceHealthMeta(conn) {
  const state = conn && typeof conn === 'object' ? conn : {};
  if (state.status === 'offline') {
    return { variant: 'danger', icon: 'wifi-off', labelKey: 'settings.healthUnknown', state: 'unknown' };
  }
  const healthState =
    state.serviceHealth && state.serviceHealth !== 'unknown'
      ? state.serviceHealth
      : state.status === 'online' && state.health
        ? state.health.ok === false
          ? 'degraded'
          : 'healthy'
        : 'unknown';
  switch (healthState) {
    case 'healthy':
      return { variant: 'ok', icon: 'check-circle', labelKey: 'settings.healthHealthy', state: 'healthy' };
    case 'degraded':
      return { variant: 'warn', icon: 'alert', labelKey: 'settings.healthDegraded', state: 'degraded' };
    case 'unhealthy':
      return { variant: 'danger', icon: 'stop', labelKey: 'settings.healthUnhealthy', state: 'unhealthy' };
    default:
      return { variant: 'warn', icon: 'clock', labelKey: 'settings.healthUnknown', state: 'unknown' };
  }
}

/** Status badge presentation for a capability matrix row. */
export function capabilityStatusMeta(status) {
  switch (status) {
    case 'ready':
      return { variant: 'ok', icon: 'check-circle', labelKey: 'settings.capStatusReady' };
    case 'degraded':
      return { variant: 'warn', icon: 'alert', labelKey: 'settings.capStatusDegraded' };
    case 'disabled':
      return { variant: 'warn', icon: 'stop', labelKey: 'settings.capStatusDisabled' };
    default:
      return { variant: 'danger', icon: 'stop', labelKey: 'settings.capStatusUnavailable' };
  }
}

/** Normalises GET /api/capabilities into structured Capability Matrix rows with remediation. */
export function normalizeCapabilityRows(payload, fetchedAt = 0) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.capabilities)) return [];
  const sourceFallback = typeof payload.schema === 'string' && payload.schema ? payload.schema : 'omnia.capabilities.v1';
  const tsFallback = Number(payload.checkedAt ?? payload.checkedAtMs ?? fetchedAt ?? 0) || 0;
  return payload.capabilities
    .map((cap) => {
      if (!cap || typeof cap !== 'object') return null;
      const id = String(cap.id ?? cap.name ?? '').trim();
      if (!id) return null;
      const rawStatus = typeof (cap.status ?? cap.readiness) === 'string' ? String(cap.status ?? cap.readiness).trim().toLowerCase() : '';
      const enabled =
        typeof cap.enabled === 'boolean'
          ? cap.enabled
          : typeof cap.ready === 'boolean'
            ? cap.ready
            : typeof cap.available === 'boolean'
              ? cap.available
              : rawStatus === 'ready' || rawStatus === 'enabled' || rawStatus === 'ok' || rawStatus === 'available';
      let status = rawStatus;
      if (!status || status === 'enabled' || status === 'ok' || status === 'available') {
        status = enabled ? 'ready' : 'unavailable';
      } else if (status === 'off' || status === 'false') {
        status = 'disabled';
      }
      if (!['ready', 'degraded', 'unavailable', 'disabled'].includes(status)) {
        status = enabled ? 'ready' : 'unavailable';
      }
      const detailParts = [];
      if (typeof cap.detail === 'string' && cap.detail.trim()) detailParts.push(cap.detail.trim());
      else if (typeof cap.reason === 'string' && cap.reason.trim()) detailParts.push(cap.reason.trim());
      else {
        if (cap.backend) detailParts.push(String(cap.backend));
        if (cap.mode) detailParts.push(String(cap.mode));
        if (cap.schema) detailParts.push(String(cap.schema));
        if (cap.invariant) detailParts.push(String(cap.invariant));
        if (Array.isArray(cap.directions) && cap.directions.length) detailParts.push(cap.directions.join('/'));
        if (Number.isFinite(cap.timeoutMs)) detailParts.push(`${cap.timeoutMs}ms`);
        if (cap.erasureReceipts === true) detailParts.push('erasureReceipts');
      }
      const rawRemediation = typeof cap.remediation === 'string' ? cap.remediation.trim() : '';
      const remediationKey =
        status === 'ready'
          ? ''
          : rawRemediation
            ? ''
            : id === 'runtime_proxy'
              ? 'settings.capRemediateRuntime'
              : 'settings.capRemediateGeneric';
      return {
        id,
        name: String(cap.name ?? id),
        endpoint: typeof cap.endpoint === 'string' ? cap.endpoint : '',
        enabled,
        status,
        meta: capabilityStatusMeta(status),
        source: typeof cap.source === 'string' && cap.source ? cap.source : sourceFallback,
        detail: detailParts.join(' · '),
        remediation: rawRemediation,
        remediationKey,
        checkedAt: Number(cap.checkedAt ?? cap.checkedAtMs ?? cap.updatedAt ?? tsFallback ?? 0) || 0
      };
    })
    .filter(Boolean);
}

export function summarizeCapabilities(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let ready = 0;
  let degraded = 0;
  let unavailable = 0;
  for (const row of list) {
    if (row.status === 'ready') ready += 1;
    else if (row.status === 'degraded') degraded += 1;
    else unavailable += 1;
  }
  return { total: list.length, ready, degraded, unavailable };
}

/** Palette → section ids, shared by the commands and the view. */
export const SECTIONS = ['appearance', 'language', 'keys', 'diag', 'local'];
export function sectionDomId(section) {
  return `settings-${section}`;
}
