// Omnia Studio UI — icon set (24×24 stroke icons, styled by .icon in base.css).
//
//   icon('send')                      → decorative (aria-hidden)
//   icon('trash', { size: 'sm' })     → 14px
//   icon('alert', { label: 'Lỗi' })   → role="img" with an accessible name
// Add new icons here only; never use emoji as icons.

import { raw, escapeHtml } from './dom.js';

const PATHS = {
  logo: '<path d="M12 2.8 21.2 12 12 21.2 2.8 12Z"/><circle class="fill" cx="12" cy="12" r="2.6"/>',
  'panel-left': '<path d="M4 5h16v14H4z"/><path d="M9.5 5v14"/>',
  'panel-right': '<path d="M4 5h16v14H4z"/><path d="M14.5 5v14"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chat: '<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  agents: '<circle cx="12" cy="5.5" r="2.3"/><circle cx="5.5" cy="17.5" r="2.3"/><circle cx="18.5" cy="17.5" r="2.3"/><path d="M10.9 7.6 6.6 15.4M13.1 7.6l4.3 7.8M7.8 17.5h8.4"/>',
  route: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><path d="M6 8.2v7.6M18 8.2c0 5.5-7.5 3.8-10.4 8.6"/>',
  book: '<path d="M5 4.5h9.5a4 4 0 0 1 4 4V20H9a4 4 0 0 1-4-4z"/><path d="M5 16a4 4 0 0 1 4-4h9.5"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a7.5 7.5 0 1 0 10.5 10.5z"/>',
  monitor: '<path d="M3.5 5h17v11h-17zM9 20h6M12 16v4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.4"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8.2 12.4 2.6 2.6 5-5.4"/>',
  alert: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4.5M12 17v.3"/>',
  'alert-circle': '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16v.3"/>',
  stop: '<path d="M8.3 3.5h7.4l4.8 4.8v7.4l-4.8 4.8H8.3l-4.8-4.8V8.3z"/><path d="m9.5 9.5 5 5M14.5 9.5l-5 5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  copy: '<path d="M8.5 8.5h11v11h-11z"/><path d="M15.5 8.5v-4h-11v11h4"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  paperclip: '<path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  sigma: '<path d="M18 5H6.5l6 7-6 7H18"/>',
  heading: '<path d="M6 5v14M18 5v14M6 12h12"/>',
  bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M10 5h8M6 19h8M14 5l-4 14"/>',
  underline: '<path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14"/>',
  code: '<path d="m9 7-5 5 5 5M15 7l5 5-5 5"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle class="fill" cx="4.5" cy="6" r="1.2"/><circle class="fill" cx="4.5" cy="12" r="1.2"/><circle class="fill" cx="4.5" cy="18" r="1.2"/>',
  'list-ordered': '<path d="M10 6h10M10 12h10M10 18h10M4 5h1.5v4M4 9h3M4 14.5c0-1 2.8-1 2.8.3 0 1-2.8 2-2.8 3.2h3"/>',
  checklist: '<path d="m4 7 2 2 3.5-3.5M4 16.5l2 2 3.5-3.5M13 8h7M13 17.5h7"/>',
  table: '<path d="M4 5h16v14H4zM4 10h16M10 10v9"/>',
  quote: '<path d="M6 17h4l1.5-5V7H6v5h3M14 17h4l1.5-5V7H14v5h3"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  send: '<path d="M4.5 11.5 20 4l-6.5 16-2.6-6.9z"/><path d="M10.9 13.1 20 4"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>',
  edit: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z"/>',
  play: '<path d="M8 5.5 18.5 12 8 18.5z"/>',
  zap: '<path d="M13 3 5 14h6.5L10.5 21 19 10h-6.5z"/>',
  shield: '<path d="M12 3.5 19 6v6c0 4.3-3 7.6-7 8.5-4-.9-7-4.2-7-8.5V6z"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8"/>',
  layers: '<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 13 8.5 4.5 8.5-4.5"/>',
  graph: '<path d="M4 4h6v6H4zM14 14h6v6h-6z"/><path d="M10 7h4a3 3 0 0 1 3 3v4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"/>',
  keyboard: '<path d="M3 6.5h18v11H3z"/><path d="M7 10.5h.01M11 10.5h.01M15 10.5h.01M7.5 14h9"/>',
  activity: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  'wifi-off': '<path d="m3 3 18 18M8.6 16.4a5 5 0 0 1 6.8 0M5.2 12.9a10 10 0 0 1 4.3-2.4M14.6 10.5a10 10 0 0 1 4.2 2.4M2 9.3a14.5 14.5 0 0 1 4-2.6M12 20h.01"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4 15v4.5h16V15"/>',
  'insert-inline': '<path d="M12 5v14M8 5h8M8 19h8"/>',
  tray: '<path d="M4 13h4l2 3h4l2-3h4M4 13l2.5-7h11L20 13v6H4z"/>',
  more: '<circle class="fill" cx="6" cy="12" r="1.3"/><circle class="fill" cx="12" cy="12" r="1.3"/><circle class="fill" cx="18" cy="12" r="1.3"/>',
  filter: '<path d="M4 5h16l-6.2 7.5V19l-3.6-1.8v-4.7z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8M17 13v6H5V7h6"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4 15v4.5h16V15"/>',
  command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>'
};

const SIZE_CLASS = { sm: 'icon icon--sm', md: 'icon', lg: 'icon icon--lg', xl: 'icon icon--xl' };

export function icon(name, { size = 'md', label = '', className = '' } = {}) {
  const body = PATHS[name] || PATHS.info;
  const cls = `${SIZE_CLASS[size] || 'icon'}${className ? ' ' + className : ''}`;
  const a11y = label ? `role="img" aria-label="${escapeHtml(label)}"` : 'aria-hidden="true" focusable="false"';
  return raw(`<svg class="${escapeHtml(cls)}" viewBox="0 0 24 24" ${a11y}>${body}</svg>`);
}

export const ICON_NAMES = Object.freeze(Object.keys(PATHS));
