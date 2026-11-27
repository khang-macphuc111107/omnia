// Omnia Studio UI — persisted user preferences, applied to <html>.
//
//   prefs.get().theme            'dark' | 'light' | 'system'
//   prefs.set({ density: 'compact' })
//   prefs.subscribe(fn)
// <html> receives data-theme (resolved dark|light), data-density, data-motion, lang.

import { createStore, storage } from './store.js';
import { setLang, LANGS } from './i18n.js';

const KEY = 'omnia.ui.prefs';

const DEFAULTS = {
  theme: 'dark',
  density: 'comfortable',
  lang: 'vi',
  reduceMotion: false,
  sidebar: 'auto',        // 'auto' | 'expanded' | 'rail'  (user choice on wide screens)
  inspectorOpen: true
};

function sanitize(value) {
  const v = { ...DEFAULTS, ...(value && typeof value === 'object' ? value : {}) };
  if (!['dark', 'light', 'system'].includes(v.theme)) v.theme = DEFAULTS.theme;
  if (!['comfortable', 'compact'].includes(v.density)) v.density = DEFAULTS.density;
  if (!LANGS.includes(v.lang)) v.lang = DEFAULTS.lang;
  if (!['auto', 'expanded', 'rail'].includes(v.sidebar)) v.sidebar = DEFAULTS.sidebar;
  v.reduceMotion = Boolean(v.reduceMotion);
  v.inspectorOpen = Boolean(v.inspectorOpen);
  return v;
}

function initialPrefs() {
  const saved = storage.get(KEY, null);
  if (saved) return sanitize(saved);
  const navLang = (navigator.language || '').toLowerCase().startsWith('vi') ? 'vi' : 'en';
  return sanitize({ lang: navLang });
}

export const prefs = createStore(initialPrefs());

const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function resolvedTheme(theme = prefs.get().theme) {
  if (theme === 'system') return darkQuery && !darkQuery.matches ? 'light' : 'dark';
  return theme;
}

function apply(state) {
  const root = document.documentElement;
  root.classList.add('omnia');
  root.setAttribute('data-theme', resolvedTheme(state.theme));
  root.setAttribute('data-density', state.density);
  if (state.reduceMotion) root.setAttribute('data-motion', 'reduce');
  else root.removeAttribute('data-motion');
  setLang(state.lang);
  root.lang = state.lang;
}

export function initPrefs() {
  apply(prefs.get());
  prefs.subscribe((state) => {
    storage.set(KEY, state);
    apply(state);
  });
  if (darkQuery && typeof darkQuery.addEventListener === 'function') {
    darkQuery.addEventListener('change', () => {
      if (prefs.get().theme === 'system') apply(prefs.get());
    });
  }
}

export function cycleTheme() {
  const order = ['dark', 'light', 'system'];
  const next = order[(order.indexOf(prefs.get().theme) + 1) % order.length];
  prefs.set({ theme: next });
  return next;
}
