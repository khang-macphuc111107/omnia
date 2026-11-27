// Omnia Studio UI — draft attachment helpers (pure apart from reading File objects).
//
// An attachment record: { id (first 8 hex of the digest), name, size, mime, sha256, placement }.
// placement is what the user chose ('inline' | 'tray' | 'both'); what is actually true for the
// current text is effectivePlacement(): an inline token that is no longer in the text means the
// file is only in the tray.

import { attachmentToken } from '../../lib/markdown.js';
import { digestBytes } from '../../lib/sha256.js';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export const shortId = (sha256) => String(sha256).slice(0, 8);
export const tokenOf = (att) => attachmentToken(att.sha256);

export function effectivePlacement(att, text) {
  const inText = String(text ?? '').includes(tokenOf(att));
  const tray = att.placement !== 'inline';
  if (!inText) return 'tray';
  return tray ? 'both' : 'inline';
}

/** Copies of the attachments carrying their effective placement (used when sending). */
export function withEffectivePlacement(attachments, text) {
  return attachments.map((att) => ({ ...att, placement: effectivePlacement(att, text) }));
}

function mergePlacement(a, b) {
  if (a === b) return a;
  return 'both';
}

/**
 * Add a record, deduplicating by full SHA-256. Returns { list, reused, record }.
 * Reusing an entry merges the placements instead of adding a second copy.
 */
export function addAttachment(list, record) {
  const at = list.findIndex((item) => item.sha256 === record.sha256);
  if (at < 0) return { list: [...list, record], reused: false, record };
  const merged = { ...list[at], placement: mergePlacement(list[at].placement, record.placement) };
  const next = list.slice();
  next[at] = merged;
  return { list: next, reused: true, record: merged };
}

export function removeAttachment(list, id) {
  return list.filter((item) => item.id !== id);
}

/** Splits files into those within the size limit and those over it. */
export function splitBySize(files, limit = MAX_FILE_BYTES) {
  const accepted = [];
  const rejected = [];
  for (const file of files) (file.size > limit ? rejected : accepted).push(file);
  return { accepted, rejected };
}

/** Reads and hashes files: [{ name, size, mime, sha256, error }] in the same order. */
export async function describeFiles(files) {
  const out = [];
  for (const file of files) {
    const base = { name: file.name || 'file', size: file.size, mime: file.type || 'application/octet-stream' };
    try {
      const sha256 = await digestBytes(await file.arrayBuffer());
      out.push({ ...base, sha256, id: shortId(sha256), error: null });
    } catch (error) {
      out.push({ ...base, sha256: '', id: '', error });
    }
  }
  return out;
}
