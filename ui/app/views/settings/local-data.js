// Settings — access to the browser-side chat data (keys omnia.ui.chat.*). Everything here
// is wrapped so a blocked or full storage never throws into the view.

import { storage } from '../../core/store.js';
import { CHAT_PREFIX, buildExport, exportFileName } from './helpers.js';

export function readChatRecords() {
  const records = [];
  for (const key of storage.keys(CHAT_PREFIX)) {
    try {
      records.push({ key, raw: window.localStorage.getItem(key) ?? '' });
    } catch {
      // unreadable key: skip
    }
  }
  return records;
}

export function clearChatRecords() {
  const before = storage.scanKeys(CHAT_PREFIX);
  if (!before.verified) return { removed: 0, failed: 0, remaining: null, verified: false };
  const removedKeys = before.keys.filter((key) => storage.remove(key));
  const after = storage.scanKeys(CHAT_PREFIX);
  const removed = after.verified
    ? before.keys.filter((key) => !after.keys.includes(key)).length
    : removedKeys.length;
  return { removed, failed: before.keys.length - removed,
    remaining: after.verified ? after.keys.length : null, verified: after.verified };
}

/** Downloads the records as JSON. The object URL is revoked right after the click. */
export function downloadChatExport(records, now = new Date()) {
  const doc = buildExport(records, now);
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = exportFileName(now);
  link.rel = 'noopener';
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return { name: link.download, sessions: doc.sessions.length };
}
