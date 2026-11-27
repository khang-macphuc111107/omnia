// Omnia Studio UI — strings and locale formatting (Vietnamese default, English).
//
// Each feature registers its own namespace so files never collide:
//   registerStrings('chat', { vi: { send: 'Gửi' }, en: { send: 'Send' } });
//   t('chat.send')                      → "Gửi"
//   t('chat.reserved', { n: '4.096' })  → "giữ chỗ 4.096 token"   (placeholders: {n})
//   t('chat.items', { count: 2 })       → uses 'items.one' / 'items.other' when defined
// Missing keys fall back to English, then to the key itself (visible in QA).

export const LANGS = ['vi', 'en'];

const dictionaries = { vi: Object.create(null), en: Object.create(null) };
const listeners = new Set();
let current = 'vi';

export function registerStrings(namespace, tables) {
  for (const lang of LANGS) {
    const table = tables[lang] || {};
    for (const [key, value] of Object.entries(table)) {
      dictionaries[lang][`${namespace}.${key}`] = value;
    }
  }
}

function lookup(lang, key) {
  return dictionaries[lang][key];
}

export function t(key, params) {
  let template;
  if (params && typeof params.count === 'number') {
    const form = params.count === 1 ? 'one' : 'other';
    template = lookup(current, `${key}.${form}`) ?? lookup('en', `${key}.${form}`);
  }
  template = template ?? lookup(current, key) ?? lookup('en', key) ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

export function getLang() {
  return current;
}

export function setLang(lang) {
  const next = LANGS.includes(lang) ? lang : 'vi';
  if (next === current) return;
  current = next;
  document.documentElement.lang = next;
  for (const listener of Array.from(listeners)) listener(next);
}

/** Subscribe to language changes; returns unsubscribe. */
export function onLangChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function locale() {
  return current === 'vi' ? 'vi-VN' : 'en-US';
}

// ---------------------------------------------------------------------------
// Formatting (always through Intl so "4.096" vs "4,096" follows the language)
// ---------------------------------------------------------------------------

export function fmtNumber(value, options) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(locale(), options).format(n);
}

export function fmtPercent(fraction, digits = 1) {
  const n = Number(fraction);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: digits }).format(n);
}

export function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${fmtNumber(n)} B`;
  if (n < 1024 * 1024) return `${fmtNumber(n / 1024, { maximumFractionDigits: 1 })} KB`;
  return `${fmtNumber(n / (1024 * 1024), { maximumFractionDigits: 1 })} MB`;
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string' && value) return new Date(value);
  return null;
}

/** 24h clock: "20:31" or "20:31:07" with seconds. */
export function fmtTime(value, withSeconds = false) {
  const d = toDate(value);
  if (!d || Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
    hour12: false
  }).format(d);
}

export function fmtDateTime(value) {
  const d = toDate(value);
  if (!d || Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(d);
}

/** "12 phút trước" / "12 minutes ago". */
export function fmtRelative(value, now = Date.now()) {
  const d = toDate(value);
  if (!d || Number.isNaN(d.getTime())) return '—';
  const seconds = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(seconds / 86400), 'day');
  return fmtDateTime(d);
}

/** Accent-insensitive, lower-case form for matching Vietnamese text ("Định" → "dinh"). */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}
