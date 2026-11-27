// Omnia Studio UI — hash router and view registry.
//
// The server has no SPA fallback, so routes live in the hash:
//   #/chat · #/chat/<sessionId> · #/agents · #/agents/code · #/routing
//   #/knowledge/memory · #/knowledge/skills · #/knowledge/rag · #/settings
//
// A view module registers itself:
//   registerView({
//     id: 'routing', order: 3, shortcut: '3', icon: 'route', placement: 'main' | 'footer',
//     label: () => t('nav.routing'),
//     title: (route) => t('nav.routing'),       // document title part
//     mount(host, route) { ...; return { update(route) {}, unmount() {} }; }
//   });
// `host` is an empty <div class="view">; the view renders its own .topbar and body.

import { withTransition } from './dom.js';

export const DEFAULT_ROUTE = '#/chat';

const registry = new Map();
const listeners = new Set();
let container = null;
let current = null; // the entry the router wants on screen: { id, instance, mountedHash }
let mounted = null; // the entry whose DOM is currently in the container

export function registerView(definition) {
  if (!definition || !definition.id || typeof definition.mount !== 'function') {
    throw new Error('registerView: id and mount() are required');
  }
  registry.set(definition.id, definition);
}

export function listViews() {
  return Array.from(registry.values()).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

export function getView(id) {
  return registry.get(id) || null;
}

export function parseRoute(hash = window.location.hash) {
  const path = String(hash || '').replace(/^#\/?/, '');
  const parts = path
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  return { view: parts[0] || '', params: parts.slice(1), hash: '#/' + parts.map(encodeURIComponent).join('/') };
}

export function buildHash(view, ...params) {
  return '#/' + [view, ...params.filter((p) => p !== undefined && p !== null && p !== '')].map(encodeURIComponent).join('/');
}

/** navigate('#/chat/abc') or navigate(buildHash('chat', id)). */
export function navigate(hash, { replace = false } = {}) {
  const target = hash.startsWith('#') ? hash : '#/' + hash.replace(/^\//, '');
  if (replace) {
    window.history.replaceState(null, '', target);
    handleRoute();
  } else if (window.location.hash === target) {
    handleRoute();
  } else {
    window.location.hash = target;
  }
}

export function currentRoute() {
  return parseRoute();
}

export function currentViewId() {
  return current ? current.id : null;
}

/** Subscribe to route changes (after the view has been mounted/updated). */
export function onRoute(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function startRouter(element) {
  container = element;
  // Route state lives in the fragment. Let the skip link move focus without
  // replacing the current route with the main landmark's ID.
  document.querySelector('.skip-link').addEventListener('click', (event) => {
    event.preventDefault();
    element.focus();
  });
  window.addEventListener('hashchange', handleRoute);
  handleRoute();
}

function renderCrash(host, error) {
  host.replaceChildren();
  const box = document.createElement('div');
  box.className = 'empty';
  const title = document.createElement('p');
  title.className = 'empty__title';
  title.textContent = 'Không hiển thị được màn hình này / This screen failed to render';
  const detail = document.createElement('p');
  detail.className = 'empty__text mono';
  detail.textContent = String((error && error.message) || error);
  box.append(title, detail);
  host.append(box);
}

function safeUpdate(entry, route) {
  if (!entry || !entry.instance || typeof entry.instance.update !== 'function') return;
  try {
    entry.instance.update(route);
  } catch (error) {
    console.error('[omnia] view update failed', error);
  }
}

// Runs inside a View Transition callback, i.e. possibly a frame later. Re-entrant
// safe: a view may call navigate(..., { replace: true }) from mount().
function mountEntry(entry, definition) {
  if (current !== entry) return; // superseded by a newer navigation
  if (mounted && mounted.instance && typeof mounted.instance.unmount === 'function') {
    try {
      mounted.instance.unmount();
    } catch (error) {
      console.error('[omnia] view unmount failed', error);
    }
  }
  container.replaceChildren();
  const host = document.createElement('div');
  host.className = 'view';
  host.dataset.view = definition.id;
  container.append(host);
  mounted = entry;

  const route = parseRoute();
  entry.mountedHash = route.hash;
  try {
    entry.instance = definition.mount(host, route) || null;
  } catch (error) {
    console.error('[omnia] view mount failed', error);
    renderCrash(host, error);
  }

  // The hash may have changed while mounting (redirects); bring the view up to date.
  const latest = parseRoute();
  if (current === entry && latest.view === entry.id && latest.hash !== entry.mountedHash) safeUpdate(entry, latest);
}

function handleRoute() {
  if (!container) return;
  let route = parseRoute();
  if (!registry.has(route.view)) {
    window.history.replaceState(null, '', DEFAULT_ROUTE);
    route = parseRoute(DEFAULT_ROUTE);
    if (!registry.has(route.view)) return;
  }
  const definition = registry.get(route.view);

  if (current && current.id === definition.id) {
    // Same view: update it, unless it is still mounting (mountEntry syncs then).
    if (current === mounted && current.instance) safeUpdate(current, route);
  } else {
    const entry = { id: definition.id, instance: null, mountedHash: '' };
    current = entry;
    withTransition(() => mountEntry(entry, definition));
  }

  const part = typeof definition.title === 'function' ? definition.title(route) : '';
  document.title = part ? `${part} · Omnia Studio` : 'Omnia Studio';
  for (const listener of Array.from(listeners)) listener(route);
}

/** Re-run the current route (e.g. after a language change). */
export function refreshRoute() {
  if (!mounted) return;
  const route = parseRoute();
  safeUpdate(mounted, route);
  const definition = registry.get(route.view);
  if (definition && typeof definition.title === 'function') {
    const part = definition.title(route);
    document.title = part ? `${part} · Omnia Studio` : 'Omnia Studio';
  }
  for (const listener of Array.from(listeners)) listener(route);
}
