// Omnia Studio UI — Workspace controller: state, painting, events, timers.
// One instance exists while the chat view is mounted; unmount() releases everything.

import { html, morph, render, on, debounce } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t, getLang, fmtBytes, fmtNumber } from '../../core/i18n.js';
import { prefs } from '../../core/prefs.js';
import { storage } from '../../core/store.js';
import { navigate, buildHash, currentRoute } from '../../core/router.js';
import { sessions, loadSessions, findSession, ensureSession } from '../../core/sessions.js';
import { openNewSessionDialog } from '../../core/shell.js';
import { openPalette } from '../../core/palette.js';
import { toast, announce, copyText, rovingFocus } from '../../core/overlay.js';
import { api, poll, describeError } from '../../api.js';
import {
  emptyChat, loadChat, saveChat, trimMessages, newMessageId, messagePolicy, pendingRoute
} from './local-store.js';
import { createRunTracker } from './run-control.js';
import { threadHtml } from './thread.js';
import { inspectorHtml } from './inspector.js';
import { composerHtml, footerHtml, previewInnerHtml, applyEditorState, replaceRange, autosize } from './composer.js';
import { askPlacement } from './placement.js';
import {
  MAX_FILE_BYTES, shortId, tokenOf, withEffectivePlacement, addAttachment, removeAttachment, splitBySize, describeFiles
} from './attachments.js';
import { insertAtCaret, wrapInline, toggleLinePrefix, insertBlock, tableSnippet, insertToken, removeToken, diffEdit } from './format.js';
import { filterTemplates, insertionText, templateTitle, gridStep } from './templates.js';

const PREVIEW_KEY = 'omnia.ui.chatPreview'; // not under omnia.ui.chat.<id>: Settings counts that prefix as sessions
const BANNER_KEY = 'omnia.ui.chatBannerHidden';
const NARROW = '(max-width: 1279px)';

// ---------------------------------------------------------------------------
// Module-level state shared by every mount (requests outlive the view)
// ---------------------------------------------------------------------------

const tracker = createRunTracker({ client: api });
export const templateCache = { status: 'idle', items: [], error: null, promise: null };
let active = null;

export function activeChat() {
  return active;
}

export function ensureTemplates(force = false) {
  if (templateCache.status === 'loading') return templateCache.promise;
  if (templateCache.status === 'ready' && !force) return Promise.resolve();
  templateCache.status = 'loading';
  templateCache.error = null;
  templateCache.promise = api.composer
    .templates()
    .then((payload) => {
      templateCache.items = Array.isArray(payload.templates) ? payload.templates : [];
      templateCache.status = 'ready';
    })
    .catch((error) => {
      templateCache.status = 'error';
      templateCache.error = error;
    })
    .finally(() => {
      templateCache.promise = null;
      if (active) active.onTemplates();
    });
  return templateCache.promise;
}

function patchRoute(sessionId, messageId, route) {
  if (active && active.loadedFor() === sessionId) {
    active.patchRoute(messageId, route);
    return;
  }
  const chat = loadChat(sessionId, (id) => tracker.isInflight(sessionId, id));
  const message = chat.messages.find((m) => m.id === messageId);
  if (!message) return;
  message.route = route;
  saveChat(sessionId, chat);
}

/** The only caller of api.router.decide: send and retry. Reserves tokens on the server. */
function runDecide(sessionId, messageId, policy) {
  return tracker.runDecide(sessionId, messageId, policy, {
    onUpdate: patchRoute,
    onSettled(route) {
      if (route.state === 'routed') announce(t('chat.routedAnnounce', { route: route.selectedCandidateId }));
      else if (route.state === 'fenced') announce(t('chat.fencedAnnounce'));
      else if (route.state === 'cancelled') announce(t('chat.cancelledAnnounce'));
      else announce(t('chat.errorAnnounce'));
    }
  });
}

function cancelDecide(sessionId, messageId) {
  return tracker.cancelRoute(sessionId, messageId, {
    onUpdate: patchRoute,
    onCancelled() {
      announce(t('chat.cancelledAnnounce'));
    }
  });
}

// ---------------------------------------------------------------------------

export function createChat(host, initialRoute) {
  let alive = true;
  let stopSteerPoll = null;
  let storageWarned = false;
  const cleanups = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };

  const S = {
    route: initialRoute,
    sessionId: null,
    sessionState: 'loading', // loading | error | empty | unknown | ready
    chat: emptyChat(),
    loadedFor: null,
    textFor: null,
    dirty: false,
    saveState: 'saved', // saved | dirty | failed
    stagger: true,
    stick: true,
    preview: storage.get(PREVIEW_KEY, true) !== false,
    previewHtml: html``,
    bannerHidden: storage.get(BANNER_KEY, false) === true,
    popover: { open: false, category: 'all', query: '', index: 0 },
    drop: null,
    composing: false,
    narrowOpen: false,
    receiptFocus: null,
    sections: { receipt: true, steer: true, atts: false },
    steer: { status: 'idle', items: [], tokenBudget: null, error: null, updatedAt: 0 },
    steerForm: { mode: 'additive', busy: false, error: '' },
    redirecting: false
  };

  render(
    host,
    html`<header class="topbar" data-region="topbar"></header>
      <div class="view__body">
        <section class="pane fill" data-region="pane">
          <div class="scroll fill chat-scroll" data-region="thread"></div>
          <div class="chat-composer-slot" data-region="composer"></div>
        </section>
        <div class="chat-slot" data-region="inspector"></div>
      </div>`
  );
  const region = (name) => host.querySelector(`[data-region="${name}"]`);
  const topbarEl = region('topbar');
  const paneEl = region('pane');
  const threadEl = region('thread');
  const composerEl = region('composer');
  const inspectorEl = region('inspector');

  const draft = () => S.chat.draft;
  const ready = () => S.sessionState === 'ready';
  const textarea = () => composerEl.querySelector('textarea.composer__input');
  const canSend = () => ready() && (draft().text.trim() !== '' || draft().attachments.length > 0);
  const narrowQuery = window.matchMedia ? window.matchMedia(NARROW) : { matches: false, addEventListener() {}, removeEventListener() {} };

  // -------------------------------------------------------------------------
  // Inspector state
  // -------------------------------------------------------------------------

  const inspectorOpen = () => (narrowQuery.matches ? S.narrowOpen : prefs.get().inspectorOpen);

  function setInspector(open) {
    if (narrowQuery.matches) {
      S.narrowOpen = open;
      onInspectorChange();
    } else {
      prefs.set({ inspectorOpen: open }); // the subscription below repaints
    }
  }

  function onInspectorChange() {
    if (!alive) return;
    paintTopbar();
    paintInspector();
    syncSteerPoll();
  }

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  function paintTopbar() {
    const session = ready() ? findSession(S.sessionId) : null;
    const open = inspectorOpen();
    morph(
      topbarEl,
      html`<h1 class="topbar__title grow">${session ? session.title || session.id : t('nav.chat')}</h1>
        ${session
          ? html`<span class="chip chip--mono hide-sm">${session.modelId || '—'}</span><span class="chip hide-sm">${session.effort || '—'}</span><span class="chip chip--mono hide-md">${t('chat.revision', { n: session.revision ?? 0 })}</span>`
          : null}
        <span class="vr hide-sm"></span>
        <button class="btn btn--ghost btn--sm" type="button" data-action="open-palette" title="${t('chat.commandTitle')}">${icon('search', { size: 'sm' })}${t('chat.command')}<span class="kbd">Ctrl K</span></button>
        <button class="btn btn--ghost btn--icon" type="button" data-action="toggle-inspector" aria-label="${t('chat.inspector')}" title="${t('chat.inspector')} (Ctrl+.)" aria-pressed="${open}">${icon('panel-right')}</button>`
    );
  }

  function paintThread() {
    paneEl.setAttribute('aria-label', t('chat.pane'));
    morph(
      threadEl,
      threadHtml({
        sessionState: S.sessionState,
        sessionId: S.sessionId,
        error: sessions.get().details[S.sessionId]?.error || sessions.get().error,
        chat: S.chat,
        bannerHidden: S.bannerHidden,
        stagger: S.stagger
      })
    );
    S.stagger = false;
    if (S.stick) requestAnimationFrame(() => alive && (threadEl.scrollTop = threadEl.scrollHeight));
  }

  function composerView() {
    return {
      draft: draft(),
      previewOn: S.preview,
      previewHtml: S.previewHtml,
      popover: S.popover,
      templates: templateCache,
      drop: S.drop,
      saveState: S.saveState,
      canSend: canSend()
    };
  }

  function paintComposer() {
    if (!ready()) {
      morph(composerEl, html``);
      S.textFor = null;
      return;
    }
    morph(composerEl, composerHtml(composerView()));
    const ta = textarea();
    if (ta && S.textFor !== S.loadedFor) {
      ta.value = draft().text;
      S.textFor = S.loadedFor;
      autosize(ta);
    }
  }

  function paintFooter() {
    const el = composerEl.querySelector('[data-role="footer"]');
    if (el) morph(el, footerHtml(composerView()));
  }

  function paintInspector() {
    if (!inspectorOpen()) {
      morph(inspectorEl, html``);
      return;
    }
    morph(inspectorEl, inspectorHtml({ chat: S.chat, steer: S.steer, steerForm: S.steerForm, sections: S.sections, receiptFocus: S.receiptFocus }));
  }

  function paintAll() {
    paintTopbar();
    paintThread();
    paintComposer();
    paintInspector();
  }

  const refreshPreviewNow = () => {
    S.previewHtml = previewInnerHtml(draft());
    if (alive && ready()) paintComposer();
  };
  const refreshPreviewSoon = debounce(refreshPreviewNow, 150);

  // -------------------------------------------------------------------------
  // Session handling
  // -------------------------------------------------------------------------

  function resolveSession() {
    const state = sessions.get();
    const paramId = S.route.params[0] || null;
    if (paramId) {
      S.sessionId = paramId;
      if (state.status === 'ready') {
        if (findSession(paramId)) S.sessionState = 'ready';
        else {
          const detail = Object.hasOwn(state.details, paramId) ? state.details[paramId] : null;
          S.sessionState = detail?.status === 'missing' ? 'unknown' : detail?.status === 'error' ? 'error' : 'loading';
          if (!detail) void ensureSession(paramId);
        }
      }
      else if (state.status === 'error') S.sessionState = 'error';
      else S.sessionState = 'loading';
      return;
    }
    S.sessionId = null;
    if (state.status === 'error') S.sessionState = 'error';
    else if (state.status !== 'ready') S.sessionState = 'loading';
    else if (!state.items.length) S.sessionState = 'empty';
    else {
      S.sessionState = 'loading';
      const target = state.activeId || state.items[0].id;
      if (!S.redirecting) {
        S.redirecting = true;
        setTimeout(() => {
          S.redirecting = false;
          if (alive && !currentRoute().params[0]) navigate(buildHash('chat', target), { replace: true });
        }, 0);
      }
    }
  }

  function leaveSession() {
    flushDraft();
    S.loadedFor = null;
    S.chat = emptyChat();
    S.textFor = null;
    S.popover = { ...S.popover, open: false };
    S.receiptFocus = null;
  }

  function enterSession(id) {
    if (S.loadedFor) leaveSession();
    S.chat = loadChat(id, (messageId) => tracker.isInflight(id, messageId));
    S.loadedFor = id;
    S.textFor = null;
    S.dirty = false;
    S.saveState = 'saved';
    S.stagger = true;
    S.stick = true;
    S.previewHtml = previewInnerHtml(draft());
  }

  function sync() {
    resolveSession();
    if (ready()) {
      if (S.loadedFor !== S.sessionId) enterSession(S.sessionId);
    } else if (S.loadedFor) {
      leaveSession();
    }
  }

  // -------------------------------------------------------------------------
  // Persistence (draft autosave, messages)
  // -------------------------------------------------------------------------

  function persist() {
    if (!S.loadedFor) return true;
    const ok = saveChat(S.loadedFor, S.chat);
    if (!ok) {
      S.saveState = 'failed';
      if (!storageWarned) {
        storageWarned = true;
        toast({ variant: 'danger', title: t('chat.storageFailTitle'), message: t('chat.storageFailText'), timeout: 9000 });
      }
    } else {
      storageWarned = false;
      if (!S.dirty) S.saveState = 'saved';
    }
    return ok;
  }

  function flushDraft() {
    flushSoon.cancel();
    if (!S.loadedFor || !S.dirty) return;
    draft().rev += 1;
    S.dirty = false;
    S.saveState = 'saved';
    persist();
    if (alive) paintFooter();
  }
  const flushSoon = debounce(flushDraft, 300);

  function markDirty() {
    S.dirty = true;
    S.saveState = 'dirty';
    flushSoon();
  }

  function patchRouteInState(messageId, route) {
    const message = S.chat.messages.find((m) => m.id === messageId);
    if (!message) return;
    message.route = route;
    persist();
    paintThread();
    paintInspector();
  }

  // -------------------------------------------------------------------------
  // Composer actions
  // -------------------------------------------------------------------------

  function editorState(ta) {
    return { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
  }

  function applyFormat(kind) {
    const ta = textarea();
    if (!ta) return;
    const state = editorState(ta);
    let next;
    if (kind === 'bold') next = wrapInline(state, '**');
    else if (kind === 'italic') next = wrapInline(state, '*');
    else if (kind === 'underline') next = wrapInline(state, '__');
    else if (kind === 'code') next = wrapInline(state, '`');
    else if (kind === 'table') next = insertBlock(state, tableSnippet((n) => t('chat.tableCol', { n })));
    else next = toggleLinePrefix(state, kind);
    applyEditorState(ta, next);
  }

  function onInput(ta) {
    draft().text = ta.value;
    autosize(ta);
    markDirty();
    paintComposer();
    refreshPreviewSoon();
  }

  function insertTemplate(template) {
    const ta = textarea();
    if (!ta || !ready()) return;
    if (S.popover.open) {
      S.popover = { ...S.popover, open: false };
      paintComposer();
    }
    applyEditorState(ta, insertAtCaret(editorState(ta), insertionText(template)));
    announce(t('chat.tplInserted', { name: templateTitle(template, getLang()) }));
  }

  function openPopover() {
    if (!ready()) return;
    S.popover = { open: true, category: 'all', query: '', index: 0 };
    ensureTemplates(templateCache.status === 'error');
    paintComposer();
    requestAnimationFrame(() => composerEl.querySelector('[data-role="tpl-search"]')?.focus());
  }

  function closePopover({ restoreFocus = true } = {}) {
    if (!S.popover.open) return;
    S.popover = { ...S.popover, open: false };
    paintComposer();
    if (restoreFocus) composerEl.querySelector('[data-role="tpl-button"]')?.focus();
  }

  const announceCount = debounce(() => {
    const n = filterTemplates(templateCache.items, S.popover).length;
    announce(t('chat.tplCount', { count: n }));
  }, 400);

  function togglePreview() {
    S.preview = !S.preview;
    storage.set(PREVIEW_KEY, S.preview);
    S.previewHtml = previewInnerHtml(draft());
    paintComposer();
    announce(t(S.preview ? 'chat.previewOn' : 'chat.previewOff'));
  }

  function focusComposer() {
    textarea()?.focus();
  }

  function send() {
    if (!canSend() || S.composing) return;
    const ta = textarea();
    const text = ta.value;
    const markdown = text.replace(/\s+$/, '');
    const sessionId = S.loadedFor;
    const id = newMessageId();
    const policy = messagePolicy(sessionId, id, markdown);
    const message = {
      id,
      role: 'user',
      markdown,
      attachments: withEffectivePlacement(draft().attachments, text),
      createdAt: Date.now(),
      route: pendingRoute(policy)
    };
    S.chat.messages = trimMessages([...S.chat.messages, message]);
    S.chat.draft = { text: '', rev: draft().rev + 1, attachments: [] };
    S.dirty = false;
    S.saveState = 'saved';
    flushSoon.cancel();
    ta.value = '';
    autosize(ta);
    S.previewHtml = previewInnerHtml(draft());
    S.receiptFocus = null;
    S.stick = true;
    persist();
    paintThread();
    paintComposer();
    paintInspector();
    ta.focus();
    announce(t('chat.sent'));
    runDecide(sessionId, id, policy);
  }

  function retry(messageId) {
    const message = S.chat.messages.find((m) => m.id === messageId);
    if (!message || (message.route.state !== 'error' && message.route.state !== 'cancelled') || tracker.isInflight(S.loadedFor, messageId)) return;
    const policy = messagePolicy(S.loadedFor, messageId, message.markdown);
    patchRouteInState(messageId, pendingRoute(policy));
    runDecide(S.loadedFor, messageId, policy);
  }

  // -------------------------------------------------------------------------
  // Attachments
  // -------------------------------------------------------------------------

  function caretOf(ta) {
    const length = ta.value.length;
    const start = Math.min(ta.selectionStart ?? length, length);
    return { start, end: Math.min(Math.max(ta.selectionEnd ?? start, start), length) };
  }

  async function ingest(fileList, origin) {
    const files = Array.from(fileList || []);
    const ta = textarea();
    if (!files.length || !ta || !ready()) return;
    const sessionId = S.loadedFor;
    const { accepted, rejected } = splitBySize(files);
    for (const file of rejected) {
      const message = t('chat.attTooBig', { name: file.name, size: fmtBytes(file.size), limit: fmtBytes(MAX_FILE_BYTES) });
      toast({ variant: 'warn', title: message });
      announce(message);
    }
    if (!accepted.length) return;

    const caret = caretOf(ta);
    announce(t('chat.hashing'));
    const described = (await describeFiles(accepted)).filter((item) => {
      if (!item.error) return true;
      toast({ variant: 'danger', title: t('chat.attReadFailed', { name: item.name }) });
      return false;
    });
    if (!described.length || !alive || S.loadedFor !== sessionId) return;

    let placement = 'tray';
    if (origin !== 'picker') {
      placement = await askPlacement({ items: described, defaultPlacement: origin === 'drop-pane' ? 'tray' : 'inline' });
      if (!placement) {
        announce(t('chat.attCancelled'));
        return; // zero mutation: text, caret and rev stay as they were
      }
      if (!alive || S.loadedFor !== sessionId) return;
    }

    let list = draft().attachments;
    let value = ta.value;
    let state = { value, start: Math.min(caret.start, value.length), end: Math.min(caret.end, value.length) };
    for (const item of described) {
      const result = addAttachment(list, { id: shortId(item.sha256), name: item.name, size: item.size, mime: item.mime, sha256: item.sha256, placement });
      list = result.list;
      if (result.reused) toast({ variant: 'info', title: t('chat.attReused', { name: item.name }) });
      if (placement === 'inline') state = insertToken(state, tokenOf(item));
    }
    draft().attachments = list;
    if (placement === 'inline') applyEditorState(ta, state);
    else onInput(ta); // refresh tray, footer and send state
    markDirty();
    paintComposer();
    paintInspector();
    refreshPreviewSoon();
    announce(described.length === 1 ? t('chat.attAdded', { name: described[0].name }) : t('chat.attAddedMany', { count: described.length }));
    if (placement === 'tray') ta.focus();
  }

  function removeDraftAttachment(id) {
    const att = draft().attachments.find((item) => item.id === id);
    if (!att) return;
    draft().attachments = removeAttachment(draft().attachments, id);
    const ta = textarea();
    if (ta) {
      const without = removeToken(ta.value, tokenOf(att));
      const edit = diffEdit(ta.value, without);
      if (edit) {
        const caret = Math.min(ta.selectionStart, without.length);
        replaceRange(ta, edit.from, edit.to, edit.insert, caret, caret);
      } else onInput(ta);
    }
    markDirty();
    paintComposer();
    paintInspector();
    refreshPreviewSoon();
    announce(t('chat.attRemoved', { name: att.name }));
    textarea()?.focus();
  }

  // -------------------------------------------------------------------------
  // Steer queue
  // -------------------------------------------------------------------------

  async function loadSteer() {
    if (!alive) return;
    if (S.steer.status === 'idle') {
      S.steer = { ...S.steer, status: 'loading' };
      paintInspector();
    }
    try {
      const payload = await api.steer.list();
      if (!alive) return;
      S.steer = { status: 'ready', items: Array.isArray(payload.items) ? payload.items : [], tokenBudget: payload.tokenBudget ?? null, error: null, updatedAt: Date.now() };
    } catch (error) {
      if (!alive) return;
      S.steer = { ...S.steer, status: 'error', error };
    }
    paintInspector();
  }

  function syncSteerPoll() {
    const want = alive && inspectorOpen();
    if (want && !stopSteerPoll) stopSteerPoll = poll(loadSteer, { every: 10000 });
    else if (!want && stopSteerPoll) {
      stopSteerPoll();
      stopSteerPoll = null;
    }
  }

  async function submitSteer() {
    if (S.steerForm.busy) return;
    const textEl = inspectorEl.querySelector('[data-role="steer-text"]');
    const modeEl = inspectorEl.querySelector('[data-role="steer-mode"]');
    if (!textEl) return;
    const text = textEl.value.trim();
    const mode = modeEl ? modeEl.value : 'additive';
    if (!text) {
      S.steerForm = { mode, busy: false, error: t('chat.steerNeedText') };
      paintInspector();
      inspectorEl.querySelector('[data-role="steer-text"]')?.focus();
      return;
    }
    S.steerForm = { mode, busy: true, error: '' };
    paintInspector();
    try {
      const payload = await api.steer.enqueue({ text, mode: mode === 'additive' ? undefined : mode });
      if (!alive) return;
      S.steer = {
        status: 'ready',
        items: Array.isArray(payload.items) ? payload.items : S.steer.items,
        tokenBudget: payload.tokenBudget ?? S.steer.tokenBudget,
        error: null,
        updatedAt: Date.now()
      };
      S.steerForm = { mode, busy: false, error: '' };
      paintInspector();
      const fresh = inspectorEl.querySelector('[data-role="steer-text"]');
      if (fresh) fresh.value = '';
      const seq = payload.item ? payload.item.seq : '';
      toast({ variant: 'ok', title: t('chat.steerAdded', { seq }), message: t('chat.steerAddedHint') });
      announce(t('chat.steerAdded', { seq }));
    } catch (error) {
      if (!alive) return;
      S.steerForm = { mode, busy: false, error: describeError(error) };
      paintInspector();
      inspectorEl.querySelector('[data-role="steer-text"]')?.focus();
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  on(host, 'click', '[data-action]', async (event, el) => {
    const action = el.getAttribute('data-action');
    switch (action) {
      case 'open-palette':
        openPalette();
        break;
      case 'toggle-inspector':
        setInspector(!inspectorOpen());
        break;
      case 'close-inspector':
        setInspector(false);
        topbarEl.querySelector('[data-action="toggle-inspector"]')?.focus();
        break;
      case 'hide-banner':
        S.bannerHidden = true;
        storage.set(BANNER_KEY, true);
        paintThread();
        break;
      case 'reload-sessions':
        if (S.sessionId) void ensureSession(S.sessionId, { retry: true });
        loadSessions();
        break;
      case 'new-session':
        openNewSessionDialog();
        break;
      case 'open-templates':
      case 'tpl-toggle':
        if (action === 'tpl-toggle' && S.popover.open) closePopover();
        else openPopover();
        break;
      case 'tpl-close':
        closePopover();
        break;
      case 'tpl-category':
        S.popover = { ...S.popover, category: el.getAttribute('data-cat') || 'all' };
        paintComposer();
        announceCount();
        break;
      case 'tpl-reload':
        el.setAttribute('aria-busy', 'true');
        ensureTemplates(true);
        paintComposer();
        break;
      case 'tpl-insert': {
        const template = templateCache.items.find((item) => item.id === el.getAttribute('data-id'));
        if (template) insertTemplate(template);
        break;
      }
      case 'attach':
        composerEl.querySelector('[data-role="file-input"]')?.click();
        break;
      case 'format':
        applyFormat(el.getAttribute('data-format'));
        break;
      case 'toggle-preview':
        togglePreview();
        break;
      case 'send':
        send();
        break;
      case 'remove-attachment':
        removeDraftAttachment(el.getAttribute('data-id'));
        break;
      case 'view-receipt':
        S.receiptFocus = el.getAttribute('data-id');
        S.sections.receipt = true;
        if (!inspectorOpen()) setInspector(true);
        else paintInspector();
        requestAnimationFrame(() => inspectorEl.querySelector('summary')?.focus());
        break;
      case 'receipt-latest':
        S.receiptFocus = null;
        paintInspector();
        break;
      case 'cancel-route':
        void cancelDecide(S.loadedFor, el.getAttribute('data-id'));
        break;
      case 'retry-route':
        retry(el.getAttribute('data-id'));
        break;
      case 'steer-submit':
        submitSteer();
        break;
      case 'steer-reload':
        el.setAttribute('aria-busy', 'true');
        loadSteer();
        break;
      case 'copy-sha': {
        const ok = await copyText(el.getAttribute('data-sha') || '');
        toast(ok ? { variant: 'info', title: t('chat.shaCopied') } : { variant: 'danger', title: t('chat.copyFailed') });
        break;
      }
      case 'copy-code': {
        const code = el.closest('.code-block')?.querySelector('code')?.textContent ?? '';
        const ok = await copyText(code);
        const message = ok ? t('chat.codeCopied', { n: fmtNumber(new TextEncoder().encode(code).length) }) : t('chat.copyFailed');
        toast({ variant: ok ? 'info' : 'danger', title: message });
        announce(message);
        break;
      }
      default:
    }
  });

  // Composer: typing, shortcuts, IME, paste, file picker, popover.
  on(composerEl, 'input', 'textarea.composer__input', (event, ta) => onInput(ta));
  on(composerEl, 'compositionstart', 'textarea.composer__input', () => {
    S.composing = true;
  });
  on(composerEl, 'compositionend', 'textarea.composer__input', () => {
    S.composing = false;
  });
  on(composerEl, 'keydown', 'textarea.composer__input', (event) => {
    if (event.isComposing || event.keyCode === 229 || S.composing) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key === 'Enter') {
      event.preventDefault();
      send();
      return;
    }
    if (mod && !event.altKey && !event.shiftKey) {
      const key = event.key.toLowerCase();
      const kind = key === 'b' ? 'bold' : key === 'i' ? 'italic' : key === 'u' ? 'underline' : null;
      if (kind) {
        event.preventDefault();
        applyFormat(kind);
      }
    }
  });
  on(composerEl, 'paste', 'textarea.composer__input', (event) => {
    const data = event.clipboardData;
    if (!data || !data.files || !data.files.length) return;
    if ((data.getData('text/plain') || '').length > 0) return; // plain text pastes normally
    event.preventDefault();
    ingest(Array.from(data.files), 'paste');
  });
  on(composerEl, 'change', '[data-role="file-input"]', (event, input) => {
    const files = Array.from(input.files || []);
    input.value = '';
    ingest(files, 'picker');
  });
  on(composerEl, 'input', '[data-role="tpl-search"]', (event, input) => {
    S.popover = { ...S.popover, query: input.value };
    paintComposer();
    announceCount();
  });
  on(composerEl, 'keydown', '.chat-popover', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePopover();
      return;
    }
    const inSearch = event.target instanceof Element && event.target.matches('[data-role="tpl-search"]');
    const cards = Array.from(composerEl.querySelectorAll('.chat-popover .tpl-card'));
    if (inSearch) {
      if (event.key === 'ArrowDown' && cards.length) {
        event.preventDefault();
        cards[0].focus();
      }
      return;
    }
    const index = cards.indexOf(document.activeElement);
    if (index < 0) return;
    const firstTop = cards[0].offsetTop;
    const columns = Math.max(1, cards.filter((card) => card.offsetTop === firstTop).length);
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = gridStep(index, event.key, columns, cards.length);
    if (next === null) composerEl.querySelector('[data-role="tpl-search"]')?.focus();
    else cards[next].focus();
  });
  cleanups.push(rovingFocus(composerEl, '.chat-popover .seg__item', {
    onActivate: (target) => {
      S.popover = { ...S.popover, category: target.getAttribute('data-cat') || 'all' };
      paintComposer();
      composerEl.querySelector(`.chat-popover [data-cat="${S.popover.category}"]`)?.focus();
      announceCount();
    }
  }));
  cleanups.push(rovingFocus(composerEl, '.composer__toolbar button'));
  listen(document, 'mousedown', (event) => {
    if (!S.popover.open || !(event.target instanceof Element)) return;
    if (event.target.closest('.chat-popover') || event.target.closest('[data-role="tpl-button"]')) return;
    closePopover({ restoreFocus: false });
  });

  // Drag and drop: input → inline at the caret, elsewhere in the pane → tray.
  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  const setDrop = (value) => {
    if (S.drop === value) return;
    S.drop = value;
    paintComposer();
  };
  listen(paneEl, 'dragover', (event) => {
    if (!hasFiles(event) || !ready()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDrop(event.target instanceof Element && event.target.closest('.composer__input') ? 'input' : 'pane');
  });
  listen(paneEl, 'dragleave', (event) => {
    if (!paneEl.contains(event.relatedTarget)) setDrop(null);
  });
  listen(paneEl, 'drop', (event) => {
    if (!hasFiles(event) || !ready()) return;
    event.preventDefault();
    const inInput = S.drop === 'input' || (event.target instanceof Element && Boolean(event.target.closest('.composer__input')));
    setDrop(null);
    ingest(Array.from(event.dataTransfer.files), inInput ? 'drop-input' : 'drop-pane');
  });
  // A file dropped outside the pane must not navigate the page away.
  listen(window, 'dragover', (event) => hasFiles(event) && event.preventDefault());
  listen(window, 'drop', (event) => hasFiles(event) && event.preventDefault());
  listen(window, 'dragend', () => setDrop(null));

  // Thread and inspector.
  listen(threadEl, 'scroll', () => {
    S.stick = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 96;
  });
  listen(inspectorEl, 'toggle', (event) => {
    const details = event.target instanceof Element ? event.target.closest('details[data-section]') : null;
    if (details) S.sections[details.getAttribute('data-section')] = details.open;
  }, true);
  on(inspectorEl, 'change', '[data-role="steer-mode"]', (event, select) => {
    S.steerForm = { ...S.steerForm, mode: select.value };
  });
  on(inspectorEl, 'keydown', '[data-role="steer-text"]', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submitSteer();
    }
  });
  listen(inspectorEl, 'keydown', (event) => {
    if (event.key === 'Escape' && narrowQuery.matches && S.narrowOpen) {
      event.preventDefault();
      setInspector(false);
      topbarEl.querySelector('[data-action="toggle-inspector"]')?.focus();
    }
  });

  // Global wiring.
  listen(window, 'omnia:toggle-inspector', () => setInspector(!inspectorOpen()));
  listen(window, 'pagehide', () => flushDraft());
  listen(window, 'resize', () => {
    const ta = textarea();
    if (ta) autosize(ta);
  });
  if (narrowQuery.addEventListener) listen(narrowQuery, 'change', onInspectorChange);
  cleanups.push(prefs.subscribe(() => onInspectorChange()));
  cleanups.push(
    sessions.subscribe(() => {
      sync();
      paintAll();
    })
  );

  // -------------------------------------------------------------------------
  // Instance
  // -------------------------------------------------------------------------

  const instance = {
    loadedFor: () => S.loadedFor,
    usable: () => ready(),
    patchRoute: patchRouteInState,
    onTemplates() {
      if (alive && ready()) paintComposer();
    },
    focusComposer,
    togglePreview,
    toggleInspector: () => setInspector(!inspectorOpen()),
    attach: () => composerEl.querySelector('[data-role="file-input"]')?.click(),
    insertTemplate,
    templates: () => (templateCache.status === 'ready' ? templateCache.items : []),
    update(route) {
      S.route = route;
      sync();
      paintAll();
      syncSteerPoll();
    },
    unmount() {
      alive = false;
      flushDraft();
      flushSoon.cancel();
      refreshPreviewSoon.cancel();
      announceCount.cancel();
      if (stopSteerPoll) stopSteerPoll();
      stopSteerPoll = null;
      for (const cleanup of cleanups.splice(0)) cleanup();
      if (active === instance) active = null;
    }
  };

  active = instance;
  sync();
  paintAll();
  syncSteerPoll();
  ensureTemplates();
  return instance;
}
