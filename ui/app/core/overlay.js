// Omnia Studio UI — dialogs, toasts, live announcements and focus helpers.
//
//   const choice = await openDialog({ title, description, body: html`…`, actions: [
//     { id: 'cancel', label: t('common.cancel') },
//     { id: 'ok', label: t('common.save'), variant: 'primary' } ],
//     onAction: async (id, el) => { if (id === 'ok' && !valid(el)) return false; } });
//   const sure = await confirmDialog({ title, message, confirmLabel, danger: true });
//   toast({ variant: 'ok', title: 'Đã lưu' });
//   announce('Đã tải 3 phiên');
//
// Every overlay: role="dialog"/"alertdialog", aria-modal, focus trapped, background
// made inert, Esc cancels (resolves null / false), focus returns to the opener.

import { html, raw, render, uid, prefersReducedMotion } from './dom.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]'
].join(',');

export function focusables(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

/** Keep Tab / Shift+Tab inside container. Returns release(). */
export function trapFocus(container) {
  const onKeydown = (event) => {
    if (event.key !== 'Tab') return;
    const items = focusables(container);
    if (items.length === 0) {
      event.preventDefault();
      container.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', onKeydown);
  return () => container.removeEventListener('keydown', onKeydown);
}

/**
 * Arrow-key navigation among items (tabs, segmented controls, lists).
 * Render tabindex="0" on the current item and "-1" on the others.
 */
export function rovingFocus(container, selector, { orientation = 'horizontal', onActivate } = {}) {
  const prev = orientation === 'vertical' ? ['ArrowUp'] : orientation === 'both' ? ['ArrowUp', 'ArrowLeft'] : ['ArrowLeft'];
  const next = orientation === 'vertical' ? ['ArrowDown'] : orientation === 'both' ? ['ArrowDown', 'ArrowRight'] : ['ArrowRight'];
  const onKeydown = (event) => {
    const active = document.activeElement instanceof Element ? document.activeElement.closest(selector) : null;
    if (!active || !container.contains(active)) return;
    const items = Array.from(container.querySelectorAll(selector)).filter((el) => !el.disabled);
    const index = items.indexOf(active);
    let target = null;
    if (prev.includes(event.key)) target = items[(index - 1 + items.length) % items.length];
    else if (next.includes(event.key)) target = items[(index + 1) % items.length];
    else if (event.key === 'Home') target = items[0];
    else if (event.key === 'End') target = items[items.length - 1];
    if (!target) return;
    event.preventDefault();
    target.focus();
    if (onActivate) onActivate(target);
  };
  container.addEventListener('keydown', onKeydown);
  return () => container.removeEventListener('keydown', onKeydown);
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

let openCount = 0;

function setBackgroundInert(inert) {
  const app = document.getElementById('omnia-app');
  if (!app) return;
  if (inert) app.setAttribute('inert', '');
  else app.removeAttribute('inert');
}

export function hasOpenOverlay() {
  return openCount > 0;
}

/**
 * Low-level modal. Returns { el, close(result), closed: Promise<result> }.
 * `content` is SafeHtml rendered inside the box.
 */
export function openOverlay({
  content,
  className = 'dialog',
  role = 'dialog',
  label = '',
  labelledBy = '',
  describedBy = '',
  initialFocus = '',
  dismissOnScrim = true,
  onKeydown = null
}) {
  const opener = document.activeElement;
  const root = document.getElementById('omnia-overlays') || document.body;

  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const box = document.createElement('div');
  box.className = className;
  box.setAttribute('role', role);
  box.setAttribute('aria-modal', 'true');
  if (labelledBy) box.setAttribute('aria-labelledby', labelledBy);
  else if (label) box.setAttribute('aria-label', label);
  if (describedBy) box.setAttribute('aria-describedby', describedBy);
  box.tabIndex = -1;
  render(box, content);
  scrim.append(box);
  root.append(scrim);

  openCount += 1;
  setBackgroundInert(true);
  const releaseTrap = trapFocus(box);

  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  let done = false;

  function close(result = null) {
    if (done) return;
    done = true;
    releaseTrap();
    // Play the exit animation (see .scrim.is-closing) unless motion is reduced.
    if (prefersReducedMotion()) {
      scrim.remove();
    } else {
      scrim.classList.add('is-closing');
      setTimeout(() => scrim.remove(), 170);
    }
    openCount = Math.max(0, openCount - 1);
    if (openCount === 0) setBackgroundInert(false);
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
      opener.focus({ preventScroll: true });
    }
    resolveClosed(result);
  }

  scrim.addEventListener('mousedown', (event) => {
    if (dismissOnScrim && event.target === scrim) close(null);
  });
  box.addEventListener('keydown', (event) => {
    if (done) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(null);
      return;
    }
    if (onKeydown) onKeydown(event, close);
  });

  requestAnimationFrame(() => {
    if (done) return;
    const target =
      (initialFocus && box.querySelector(initialFocus)) ||
      box.querySelector('[autofocus]') ||
      focusables(box)[0] ||
      box;
    target.focus();
  });

  return { el: box, close, closed, get isOpen() { return !done; } };
}

const BUTTON_CLASS = {
  primary: 'btn btn--primary',
  danger: 'btn btn--danger-solid',
  ghost: 'btn btn--ghost',
  default: 'btn'
};

/**
 * Standard dialog. Resolves with the clicked action id, or null on Esc/scrim.
 * onAction(id, dialogEl) may return false (or a Promise of false) to keep it open.
 */
export function openDialog({
  title,
  description = '',
  body = null,
  actions = [{ id: 'close', label: t('common.close'), variant: 'primary' }],
  role = 'dialog',
  size = 'md',
  initialFocus = '',
  onAction = null
}) {
  const titleId = uid('dlg-title');
  const descId = description ? uid('dlg-desc') : '';
  const content = html`
    <div class="dialog__header">
      <h2 class="dialog__title" id="${titleId}">${title}</h2>
      ${description ? html`<p class="dialog__desc" id="${descId}">${description}</p>` : null}
    </div>
    ${body ? html`<div class="dialog__body">${body}</div>` : null}
    ${actions.length
      ? html`<div class="dialog__footer">${actions.map(
          (action) => html`<button type="button" class="${BUTTON_CLASS[action.variant] || BUTTON_CLASS.default}" data-dialog-action="${action.id}"${action.autofocus ? raw(' autofocus') : null}>${action.label}</button>`
        )}</div>`
      : null}`;

  const overlay = openOverlay({
    content,
    className: `dialog dialog--${size}`,
    role,
    labelledBy: titleId,
    describedBy: descId,
    initialFocus,
    onKeydown: (event) => {
      // Enter inside a single-line field triggers the primary action.
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.type === 'checkbox' || target.type === 'radio') return;
      const primary = overlay.el.querySelector('.dialog__footer .btn--primary, .dialog__footer .btn--danger-solid');
      if (primary) {
        event.preventDefault();
        primary.click();
      }
    }
  });

  let actionPending = false;

  overlay.el.addEventListener('click', async (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-dialog-action]') : null;
    if (!button || button.disabled || actionPending || !overlay.isOpen) return;
    const id = button.getAttribute('data-dialog-action');
    if (onAction) {
      actionPending = true;
      const priorState = Array.from(overlay.el.querySelectorAll('[data-dialog-action]'), (b) => ({
        button: b, disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled')
      }));
      const priorFocus = document.activeElement;
      // Native disabled blocks Enter/click activation; the handler also fences
      // delegated events and actions queued while the overlay is closing.
      priorState.forEach(({ button: b }) => {
        b.disabled = true;
        b.setAttribute('aria-disabled', 'true');
      });
      // Show a spinner on the clicked button if the action takes a moment.
      const busyTimer = setTimeout(() => button.setAttribute('aria-busy', 'true'), 120);
      let keepOpen = false;
      try {
        keepOpen = (await onAction(id, overlay.el)) === false;
      } catch (error) {
        console.error('[omnia] dialog action failed', error);
        keepOpen = true;
      }
      clearTimeout(busyTimer);
      button.removeAttribute('aria-busy');
      actionPending = false;
      if (!overlay.isOpen) return;
      if (keepOpen) {
        priorState.forEach(({ button: b, disabled, ariaDisabled }) => {
          b.disabled = disabled;
          if (ariaDisabled === null) b.removeAttribute('aria-disabled');
          else b.setAttribute('aria-disabled', ariaDisabled);
        });
        if (priorFocus === button && (document.activeElement === document.body || document.activeElement === overlay.el)) {
          button.focus();
        }
        return;
      }
    }
    overlay.close(id);
  });

  return overlay.closed;
}

/** Resolves true only when the user confirms. Destructive dialogs focus Cancel first. */
export async function confirmDialog({ title, message = '', confirmLabel = t('common.confirm'), cancelLabel = t('common.cancel'), danger = false }) {
  const result = await openDialog({
    title,
    description: message,
    role: 'alertdialog',
    size: 'sm',
    actions: [
      { id: 'cancel', label: cancelLabel, autofocus: danger },
      { id: 'confirm', label: confirmLabel, variant: danger ? 'danger' : 'primary', autofocus: !danger }
    ]
  });
  return result === 'confirm';
}

// ---------------------------------------------------------------------------
// Toasts and announcements
// ---------------------------------------------------------------------------

const TOAST_ICON = { ok: 'check-circle', warn: 'alert', danger: 'stop', info: 'info' };
const MAX_TOASTS = 4;

export function toast({ title = '', message = '', variant = 'info', timeout = 5000 } = {}) {
  const region = document.getElementById('omnia-toasts');
  if (!region) return () => {};
  const el = document.createElement('div');
  el.className = `toast toast--${variant}`;
  el.setAttribute('role', variant === 'danger' ? 'alert' : 'status');
  render(
    el,
    html`${icon(TOAST_ICON[variant] || 'info', { className: 'toast__icon' })}
      <div class="col grow" style="gap: 2px;">
        ${title ? html`<span class="strong">${title}</span>` : null}
        ${message ? html`<span class="subtle">${message}</span>` : null}
      </div>
      <button type="button" class="btn btn--ghost btn--icon btn--sm" data-toast-close aria-label="${t('common.close')}">${icon('x', { size: 'sm' })}</button>`
  );
  region.append(el);
  while (region.children.length > MAX_TOASTS) region.firstElementChild.remove();

  let timer = null;
  let leaving = false;
  const dismiss = () => {
    clearTimeout(timer);
    if (leaving) return;
    leaving = true;
    if (prefersReducedMotion()) {
      el.remove();
      return;
    }
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 210);
  };
  const arm = () => {
    if (timeout > 0) timer = setTimeout(dismiss, timeout);
  };
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', arm);
  el.addEventListener('focusin', () => clearTimeout(timer));
  el.addEventListener('focusout', arm);
  el.querySelector('[data-toast-close]').addEventListener('click', dismiss);
  arm();
  return dismiss;
}

/** Polite screen-reader announcement (e.g. "3 kết quả"). */
export function announce(text) {
  const region = document.getElementById('omnia-announcer');
  if (!region) return;
  region.textContent = '';
  requestAnimationFrame(() => {
    region.textContent = String(text ?? '');
  });
}

/** Copy text to the clipboard; resolves true on success. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(String(text));
      return true;
    }
  } catch {
    // fall back below
  }
  const area = document.createElement('textarea');
  area.value = String(text);
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
