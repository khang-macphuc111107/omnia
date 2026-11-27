// Omnia Studio UI — DOM toolkit.
//
// Rendering model: a view builds markup with the `html` tagged template (every
// interpolated value is HTML-escaped unless it is already SafeHtml), then calls
// `morph(container, markup)` which patches the live DOM in place. Nodes that did
// not change are kept, so focus, caret, scroll and IME composition survive a
// re-render. Events are handled with delegation (`on`).
//
// Rules for templates:
//   - Always quote attribute values: title="${text}".
//   - Booleans render as "true"/"false" (useful for ARIA). For conditional
//     markup use a ternary: ${cond ? html`...` : null}. null/undefined render nothing.
//   - Arrays are flattened, so ${items.map((x) => html`<li>${x}</li>`)} works.
//   - Give repeated elements a stable data-key so morph can reorder them.
//   - Mark imperatively managed subtrees (canvas, third-party widgets) with
//     data-morph-skip; morph will never touch them or their attributes.
//   - <textarea> values are never overwritten by morph unless the element has
//     data-controlled. <input value="..."> is synced only while not focused.
//   - data-preserve="open hidden" keeps the listed attributes as the user left them.

export class SafeHtml {
  constructor(value) {
    this.value = value;
  }

  toString() {
    return this.value;
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** Mark trusted markup (icons, renderer output) as safe. Never pass user text here. */
export function raw(markup) {
  return new SafeHtml(String(markup ?? ''));
}

export function isSafe(value) {
  return value instanceof SafeHtml;
}

function interpolate(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join('');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return escapeHtml(value);
}

/** Tagged template: html`<p>${userText}</p>` → SafeHtml with userText escaped. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += interpolate(values[i]) + strings[i + 1];
  }
  return new SafeHtml(out);
}

/** Join several fragments (SafeHtml or escaped text). */
export function join(parts, separator = '') {
  return new SafeHtml(parts.map(interpolate).join(interpolate(separator)));
}

/** Build a class attribute value from a map: cx('btn', { 'btn--primary': primary }). */
export function cx(...args) {
  const out = [];
  for (const arg of args) {
    if (!arg) continue;
    if (typeof arg === 'string') out.push(arg);
    else if (typeof arg === 'object') {
      for (const [name, on] of Object.entries(arg)) if (on) out.push(name);
    }
  }
  return out.join(' ');
}

// ---------------------------------------------------------------------------
// morph: patch `target`'s children so they match `markup`.
// ---------------------------------------------------------------------------

// Only SafeHtml is parsed as markup; anything else is escaped and shown as text,
// so a forgotten `html` tag can never inject markup.
function toMarkup(markup) {
  return markup instanceof SafeHtml ? markup.value : escapeHtml(markup ?? '');
}

export function morph(target, markup) {
  if (!target) return;
  const template = document.createElement('template');
  template.innerHTML = toMarkup(markup);
  morphChildren(target, template.content);
}

/** Replace target's children without diffing (use for first render of big static blocks). */
export function render(target, markup) {
  if (!target) return;
  target.innerHTML = toMarkup(markup);
}

function keyOf(node) {
  if (node.nodeType !== 1) return null;
  const key = node.getAttribute('data-key');
  if (key !== null) return 'k:' + key;
  return node.id ? 'id:' + node.id : null;
}

function sameKind(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== 1) return true;
  if (a.nodeName !== b.nodeName) return false;
  if (a.nodeName === 'INPUT' && (a.getAttribute('type') || 'text') !== (b.getAttribute('type') || 'text')) return false;
  return true;
}

function morphChildren(parent, next) {
  const nextNodes = Array.from(next.childNodes);
  const keyed = new Map();
  for (const child of parent.childNodes) {
    const key = keyOf(child);
    if (key) keyed.set(key, child);
  }

  let cursor = parent.firstChild;
  for (const incoming of nextNodes) {
    const key = keyOf(incoming);
    let match = null;
    if (key) {
      const candidate = keyed.get(key);
      if (candidate && sameKind(candidate, incoming)) {
        match = candidate;
        keyed.delete(key);
      }
    } else if (cursor && !keyOf(cursor) && sameKind(cursor, incoming)) {
      match = cursor;
    }

    if (match) {
      if (match === cursor) cursor = cursor.nextSibling;
      else parent.insertBefore(match, cursor);
      patchNode(match, incoming);
    } else {
      parent.insertBefore(incoming, cursor);
    }
  }

  while (cursor) {
    const following = cursor.nextSibling;
    parent.removeChild(cursor);
    cursor = following;
  }
}

function patchNode(current, incoming) {
  if (current.nodeType === 3 || current.nodeType === 8) {
    if (current.nodeValue !== incoming.nodeValue) current.nodeValue = incoming.nodeValue;
    return;
  }
  if (current.nodeType !== 1) return;
  if (current.hasAttribute('data-morph-skip') && incoming.hasAttribute('data-morph-skip')) return;

  syncAttributes(current, incoming);

  switch (current.nodeName) {
    case 'INPUT':
      syncInput(current, incoming);
      return;
    case 'TEXTAREA':
      if (incoming.hasAttribute('data-controlled') && document.activeElement !== current) {
        if (current.value !== incoming.value) current.value = incoming.value;
      }
      return;
    case 'SELECT':
      morphChildren(current, incoming);
      syncSelect(current, incoming);
      return;
    default:
      morphChildren(current, incoming);
  }
}

function syncAttributes(current, incoming) {
  const preserved = new Set((current.getAttribute('data-preserve') || '').split(/\s+/).filter(Boolean));
  for (const attr of Array.from(current.attributes)) {
    if (preserved.has(attr.name)) continue;
    if (!incoming.hasAttribute(attr.name)) current.removeAttribute(attr.name);
  }
  for (const attr of Array.from(incoming.attributes)) {
    if (preserved.has(attr.name) && current.hasAttribute(attr.name)) continue;
    if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
  }
}

function syncInput(current, incoming) {
  const type = (incoming.getAttribute('type') || 'text').toLowerCase();
  if (type === 'checkbox' || type === 'radio') {
    current.checked = incoming.hasAttribute('checked');
    return;
  }
  if (incoming.hasAttribute('value') && document.activeElement !== current) {
    const value = incoming.getAttribute('value');
    if (current.value !== value) current.value = value;
  }
}

function syncSelect(current, incoming) {
  if (document.activeElement === current) return;
  const selected = incoming.querySelector('option[selected]');
  if (selected) {
    const value = selected.getAttribute('value') ?? selected.textContent;
    if (current.value !== value) current.value = value;
  }
}

// ---------------------------------------------------------------------------
// Queries, events, scheduling
// ---------------------------------------------------------------------------

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/**
 * Delegated listener: on(root, 'click', '[data-action]', (event, el) => ...).
 * Returns an unsubscribe function.
 */
export function on(root, type, selector, handler, options) {
  const listener = (event) => {
    const target = event.target instanceof Element ? event.target.closest(selector) : null;
    if (target && root.contains(target)) handler(event, target);
  };
  root.addEventListener(type, listener, options);
  return () => root.removeEventListener(type, listener, options);
}

/** Coalesce many calls in the same tick into one call of fn. */
export function batched(fn) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      fn();
    });
  };
}

export function debounce(fn, wait = 200) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

/** Stable ids for label/aria wiring: uid('field') → "field-7". */
let uidCounter = 0;
export function uid(prefix = 'o') {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

/** True when the user asked for reduced motion (OS setting or Omnia setting). */
export function prefersReducedMotion() {
  if (document.documentElement.getAttribute('data-motion') === 'reduce') return true;
  return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** Run a DOM update inside a View Transition when supported and motion is allowed. */
export function withTransition(update) {
  if (typeof document.startViewTransition === 'function' && !prefersReducedMotion() && !document.hidden) {
    try {
      const transition = document.startViewTransition(update);
      // A skipped/aborted transition still runs `update`; swallow its rejections.
      for (const promise of [transition.ready, transition.finished, transition.updateCallbackDone]) {
        if (promise && typeof promise.catch === 'function') promise.catch(() => {});
      }
      return;
    } catch {
      // fall through to a plain update
    }
  }
  update();
}
