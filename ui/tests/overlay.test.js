import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDialog, hasOpenOverlay } from '../app/core/overlay.js';
import { html } from '../app/core/dom.js';

// A small DOM adapter drives the actual dialog handlers. This verifies event
// admission and cleanup, not browser layout, focus traversal or accessibility.
function installDom(t) {
  class TestElement {
    attrs = new Map();
    children = [];
    listeners = new Map();
    parent = null;
    offsetParent = {};
    className = '';
    classList = { add() {} };
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    getAttribute(k) { return this.attrs.get(k) ?? null; }
    removeAttribute(k) { this.attrs.delete(k); }
    get disabled() { return this.attrs.has('disabled'); }
    set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
    append(child) { child.parent = this; this.children.push(child); }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    }
    contains(child) { return child === this || this.children.some((item) => item.contains(child)); }
    focus() { document.activeElement = this; }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    fire(type, target = this, props = {}) {
      const event = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {}, ...props };
      for (const fn of this.listeners.get(type) ?? []) fn(event);
      return event;
    }
    closest(selector) {
      if (selector === '[data-dialog-action]' && this.attrs.has('data-dialog-action')) return this;
      return this.parent?.closest(selector) ?? null;
    }
    click() { if (!this.disabled) this.parent?.fire('click', this); }
    set innerHTML(value) {
      this.children = [];
      for (const match of value.matchAll(/<(button|input)\b([^>]*)>/g)) {
        const el = match[1] === 'input' ? new TestInput() : new TestElement();
        el.tagName = match[1].toUpperCase();
        for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) el.setAttribute(attr[1], attr[2]);
        el.className = el.getAttribute('class') || '';
        this.append(el);
      }
    }
    querySelectorAll(selector) {
      if (selector === '[data-dialog-action]') return this.children.filter((el) => el.attrs.has('data-dialog-action'));
      return this.children.filter((el) => !el.disabled);
    }
    querySelector(selector) {
      if (selector.startsWith('.dialog__footer')) {
        return this.children.find((el) => /btn--(primary|danger-solid)/.test(el.className)) ?? null;
      }
      if (selector.startsWith('#')) return this.children.find((el) => el.getAttribute('id') === selector.slice(1)) ?? null;
      if (selector === '[autofocus]') return null;
      return null;
    }
  }
  class TestInput extends TestElement { type = 'text'; }
  const root = new TestElement(), app = new TestElement(), opener = new TestElement();
  const frameCallbacks = [];
  const globals = {
    Element: TestElement, HTMLInputElement: TestInput,
    document: { activeElement: opener, body: root,
      documentElement: { getAttribute: () => 'reduce' },
      createElement: () => new TestElement(), contains: (el) => el === opener || root.contains(el),
      getElementById: (id) => id === 'omnia-app' ? app : id === 'omnia-overlays' ? root : null },
    requestAnimationFrame: (fn) => { frameCallbacks.push(fn); }
  };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  t.after(() => {
    for (const scrim of [...root.children]) scrim.children[0]?.fire('keydown', undefined, { key: 'Escape' });
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { root, app, opener, frame: () => frameCallbacks.splice(0).forEach((fn) => fn()) };
}

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
function show(onAction) {
  const closed = openDialog({ title: 'Create session', body: html`<input id="title">`, initialFocus: '#title',
    actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'create', label: 'Create', variant: 'primary' }], onAction });
  const dialog = document.body.children.at(-1).children[0];
  const [cancel, create] = dialog.querySelectorAll('[data-dialog-action]');
  return { closed, dialog, cancel, create, input: dialog.querySelector('#title') };
}

test('dialog admits one action across repeated clicks, Enter and delegated events', async (t) => {
  installDom(t);
  const pending = deferred();
  const calls = [];
  const { closed, dialog, cancel, create, input } = show((id) => { calls.push(id); return pending.promise; });
  create.click();
  create.click();
  dialog.fire('keydown', input, { key: 'Enter' });
  dialog.fire('click', cancel); // dispatch bypasses native disabled activation
  assert.deepEqual(calls, ['create']);
  assert.equal(create.disabled, true);
  assert.equal(cancel.disabled, true);
  pending.resolve(true);
  assert.equal(await closed, 'create');
  dialog.fire('click', create);
  await settle();
  assert.deepEqual(calls, ['create']);
  assert.equal(hasOpenOverlay(), false);
});

test('validation and rejected actions restore prior button states and permit retry', async (t) => {
  installDom(t);
  t.mock.method(console, 'error', () => {});
  let calls = 0;
  const { closed, dialog, cancel, create } = show(async () => {
    calls += 1;
    if (calls === 1) return false;
    if (calls === 2) throw new Error('temporary failure');
    return true;
  });
  cancel.disabled = true;
  cancel.setAttribute('aria-disabled', 'true');
  create.click();
  await settle();
  assert.equal(create.disabled, false);
  assert.equal(cancel.disabled, true);
  assert.equal(cancel.getAttribute('aria-disabled'), 'true');
  assert.equal(create.getAttribute('aria-busy'), null);
  create.click();
  await settle();
  assert.equal(create.disabled, false);
  assert.equal(cancel.disabled, true);
  create.click();
  assert.equal(await closed, 'create');
  dialog.fire('click', create);
  assert.equal(calls, 3);
});

test('Escape during an action closes once and ignores late completion and queued focus', async (t) => {
  const dom = installDom(t);
  const pending = deferred();
  let calls = 0;
  const { closed, dialog, create } = show(() => { calls += 1; return pending.promise; });
  create.click();
  dialog.fire('keydown', create, { key: 'Escape' });
  assert.equal(await closed, null);
  pending.resolve(false);
  await settle();
  create.click();
  dialog.fire('click', create);
  dom.frame();
  assert.equal(calls, 1);
  assert.equal(document.activeElement, dom.opener);
  assert.equal(dom.app.getAttribute('inert'), null);
});

test('dialog Enter ignores composition and Shift while allowing a normal field submit', async (t) => {
  installDom(t);
  let calls = 0;
  const { closed, dialog, input } = show(() => { calls += 1; return true; });
  dialog.fire('keydown', input, { key: 'Enter', isComposing: true });
  dialog.fire('keydown', input, { key: 'Enter', shiftKey: true });
  assert.equal(calls, 0);
  dialog.fire('keydown', input, { key: 'Enter' });
  assert.equal(await closed, 'create');
  assert.equal(calls, 1);
});
