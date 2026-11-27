// Omnia Studio UI — application shell: sidebar, sidebar modes, new-session dialog,
// global shortcuts, connection notifications and the app-wide palette commands.
//
// Sidebar modes (html[data-sidebar]):
//   ≥1100px: "expanded" (default) or "rail" (Ctrl+B toggles, remembered in prefs)
//   <1100px: "rail" by default; Ctrl+B / the expand button opens it as a "drawer".
//
// Global shortcuts: Ctrl+K palette · Ctrl+B sidebar (not inside [data-editor]) ·
// Alt+1…5 views · Alt+T theme · Ctrl+. inspector (window event "omnia:toggle-inspector").

import { html, raw, morph, on, batched, debounce } from './dom.js';
import { icon } from './icons.js';
import { t, fold, fmtRelative, fmtDateTime, getLang, onLangChange } from './i18n.js';
import { prefs, cycleTheme } from './prefs.js';
import { storage } from './store.js';
import { listViews, currentRoute, onRoute, navigate, buildHash, refreshRoute } from './router.js';
import { sessions, loadSessions, loadMoreSessions, createSession, setActiveSession } from './sessions.js';
import { connection, retryConnection, api, EFFORTS, describeError } from '../api.js';
import { openDialog, toast, hasOpenOverlay } from './overlay.js';
import { openPalette, isPaletteOpen, closePalette, registerCommands } from './palette.js';

const WIDE = 1100;
const ui = { filter: '', drawerOpen: false };
let sidebarEl = null;

function isWide() {
  return window.innerWidth >= WIDE;
}

function sidebarMode() {
  if (isWide()) return prefs.get().sidebar === 'rail' ? 'rail' : 'expanded';
  return ui.drawerOpen ? 'drawer' : 'rail';
}

function applyMode() {
  document.documentElement.setAttribute('data-sidebar', sidebarMode());
}

export function toggleSidebar() {
  if (isWide()) {
    prefs.set({ sidebar: sidebarMode() === 'rail' ? 'expanded' : 'rail' });
  } else {
    ui.drawerOpen = !ui.drawerOpen;
    applyMode();
    paint();
    if (ui.drawerOpen) requestAnimationFrame(() => sidebarEl && sidebarEl.querySelector('.nav-item')?.focus());
  }
}

function closeDrawer({ restoreFocus = false } = {}) {
  if (!ui.drawerOpen) return;
  ui.drawerOpen = false;
  applyMode();
  paint();
  if (restoreFocus) sidebarEl?.querySelector('.rail-only')?.focus();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const THEME_ICON = { dark: 'moon', light: 'sun', system: 'monitor' };

function themeLabel(theme) {
  return theme === 'light' ? t('shell.themeLight') : theme === 'system' ? t('shell.themeSystem') : t('shell.themeDark');
}

function navItem(view, route) {
  const current = route.view === view.id;
  const label = view.label();
  const shortcut = view.shortcut ? ` (Alt+${view.shortcut})` : '';
  return html`<a class="nav-item" href="#/${view.id}" data-key="nav-${view.id}" aria-current="${current ? 'page' : 'false'}" title="${label}${shortcut}">
      ${icon(view.icon || 'arrow-right')}<span class="nav-label rail-hide">${label}</span>${view.shortcut ? html`<span class="kbd rail-hide">Alt ${view.shortcut}</span>` : null}
    </a>`;
}

function sessionList(state) {
  if (state.status === 'loading' && state.items.length === 0) {
    return html`<div class="col" style="gap: 10px; padding: 6px 8px;" aria-hidden="true">
        ${[70, 82, 60].map((w) => html`<div class="col" style="gap: 5px;"><span class="skeleton" style="height: 11px; width: ${w}%;"></span><span class="skeleton" style="height: 9px; width: 45%;"></span></div>`)}
      </div><span class="sr-only" role="status">${t('common.loading')}</span>`;
  }
  if (state.status === 'error' && state.items.length === 0) {
    return html`<div class="col" style="gap: 6px; padding: 4px 8px;">
        <p class="text-xs" style="color: var(--danger);">${t('shell.loadFailed')} ${describeError(state.error)}</p>
        <button type="button" class="btn btn--sm" data-action="reload-sessions" style="align-self: flex-start;">${icon('refresh', { size: 'sm' })}${t('common.retry')}</button>
      </div>`;
  }
  if (state.items.length === 0) {
    return html`<p class="text-xs muted" style="padding: 4px 8px;">${t('shell.noSessions')}</p>`;
  }
  const needle = fold(ui.filter).trim();
  const items = needle
    ? state.items.filter((s) => fold(`${s.title} ${s.modelId} ${s.effort}`).includes(needle))
    : state.items;
  return html`${items.length === 0 ? html`<p class="text-xs muted" style="padding: 4px 8px;">${t('shell.noMatch')}</p>` : null}
    <ul class="session-list" style="list-style: none; margin: 0; padding: 0;">
      ${items.map(
        (s) => html`<li data-key="s-${s.id}"><a class="session-item" href="${buildHash('chat', s.id)}" aria-current="${s.id === state.activeId ? 'true' : 'false'}">
            <span class="session-item__title">${s.title || s.id}</span>
            <span class="session-item__meta">${s.modelId || '—'} · ${s.effort || '—'} · ${fmtRelative(s.updatedAt)}</span>
          </a></li>`
      )}
    </ul>
    ${state.pageError ? html`<p class="text-xs" role="alert" style="padding: 4px 8px; color: var(--danger);">${describeError(state.pageError)}</p>` : null}
    ${state.nextCursor ? html`<button type="button" class="btn btn--sm" data-action="more-sessions" aria-busy="${state.loadingMore}"${state.loadingMore ? raw(' disabled') : null}>${state.loadingMore ? t('common.loading') : state.pageError ? t('common.retry') : t('shell.loadMore')}</button>` : null}`;
}

function connIndicator(state) {
  const label = state.status === 'online' ? t('shell.connected') : state.status === 'offline' ? t('shell.offline') : t('shell.connecting');
  const cls = state.status === 'online' ? 'conn' : state.status === 'offline' ? 'conn conn--offline' : 'conn conn--connecting';
  const where = window.location.host || '127.0.0.1';
  return html`<span class="${cls}" role="status" title="${label} · ${where}">
      <span class="conn__dot"></span><span class="truncate rail-hide">${label} · ${where}</span>
    </span>
    ${state.status === 'offline'
      ? html`<button type="button" class="btn btn--ghost btn--sm rail-hide" data-action="retry-connection">${t('common.retry')}</button>`
      : null}`;
}

function paint() {
  if (!sidebarEl) return;
  const route = currentRoute();
  const views = listViews();
  const mainViews = views.filter((v) => (v.placement || 'main') === 'main');
  const footerViews = views.filter((v) => v.placement === 'footer');
  const theme = prefs.get().theme;

  morph(
    sidebarEl,
    html`
      <div class="row between rail-hide">
        <a class="brand" href="#/chat" aria-label="Omnia Studio">
          <span class="brand__mark">${icon('logo')}</span><span>Omnia</span><span class="brand__tag">Studio</span>
        </a>
        <button type="button" class="btn btn--ghost btn--icon btn--sm" data-action="toggle-sidebar" aria-label="${t('shell.collapse')}" title="${t('shell.collapse')}">${icon('panel-left')}</button>
      </div>
      <button type="button" class="btn btn--ghost btn--icon rail-only" data-action="toggle-sidebar" aria-label="${t('shell.expand')}" title="${t('shell.expand')}">${icon('panel-left')}</button>
      <button type="button" class="btn btn--block btn--start" data-action="new-session" title="${t('shell.newSession')}">${icon('plus')}<span class="rail-hide">${t('shell.newSession')}</span></button>
      <nav class="nav" aria-label="${t('nav.main')}">${mainViews.map((v) => navItem(v, route))}</nav>
      <section class="col fill rail-hide" style="gap: 6px;" aria-labelledby="omnia-recent">
        <div class="row between" style="padding: 0 8px;">
          <h2 class="section-title" id="omnia-recent">${t('shell.recent')}</h2>
          <span class="count">${sessions.get().items.length}</span>
        </div>
        <div class="input-group">
          ${icon('search', { size: 'sm' })}
          <input class="input" type="search" data-role="session-filter" placeholder="${t('shell.filter')}" aria-label="${t('shell.filter')}" value="${ui.filter}">
        </div>
        ${sessionList(sessions.get())}
      </section>
      <div class="sidebar__footer">
        ${footerViews.map((v) => navItem(v, route))}
        <div class="row between wrap" style="padding: 0 4px 0 8px; gap: 4px;">
          ${connIndicator(connection.get())}
          <button type="button" class="btn btn--ghost btn--icon btn--sm rail-hide" data-action="cycle-theme" aria-label="${themeLabel(theme)} · ${t('shell.themeCycle')}" title="${themeLabel(theme)}">${icon(THEME_ICON[theme] || 'moon')}</button>
        </div>
      </div>`
  );
}

const paintSoon = batched(paint);

// ---------------------------------------------------------------------------
// New session
// ---------------------------------------------------------------------------

export async function openNewSessionDialog() {
  closeDrawer();
  let models = [];
  try {
    const state = await api.router.state({ timeout: 4000 });
    models = Array.from(new Set((state.candidates || []).map((c) => c.modelId).filter(Boolean)));
  } catch {
    models = [];
  }
  const lastModel = storage.get('omnia.ui.lastModel', models[0] || '');
  const lastEffort = storage.get('omnia.ui.lastEffort', 'high');
  const defaultTitle = t('session.defaultTitle', { time: fmtDateTime(Date.now()) });

  const body = html`<div class="col gap-3">
      <div class="field">
        <label class="field__label" for="ns-title">${t('session.title')}</label>
        <input class="input" id="ns-title" maxlength="200" value="${defaultTitle}" autocomplete="off">
      </div>
      <div class="field">
        <label class="field__label" for="ns-model">${t('session.model')}</label>
        <input class="input input--mono" id="ns-model" list="ns-models" value="${lastModel}" autocomplete="off" spellcheck="false" aria-describedby="ns-model-hint">
        <datalist id="ns-models">${models.map((m) => html`<option value="${m}"></option>`)}</datalist>
        <span class="field__hint" id="ns-model-hint">${t('session.modelHint')}</span>
      </div>
      <div class="field">
        <label class="field__label" for="ns-effort">${t('session.effort')}</label>
        <select class="select" id="ns-effort">${EFFORTS.map((e) => html`<option value="${e}"${e === lastEffort ? raw(' selected') : null}>${e}</option>`)}</select>
      </div>
      <p class="field__error" data-role="ns-error" role="alert" hidden></p>
    </div>`;

  await openDialog({
    title: t('session.createTitle'),
    description: t('session.createDesc'),
    body,
    initialFocus: '#ns-title',
    actions: [
      { id: 'cancel', label: t('common.cancel') },
      { id: 'create', label: t('session.create'), variant: 'primary' }
    ],
    onAction: async (id, el) => {
      if (id !== 'create') return true;
      const titleEl = el.querySelector('#ns-title');
      const modelEl = el.querySelector('#ns-model');
      const errorEl = el.querySelector('[data-role="ns-error"]');
      const fail = (message, field) => {
        errorEl.textContent = message;
        errorEl.hidden = false;
        if (field) {
          field.setAttribute('aria-invalid', 'true');
          field.focus();
        }
        return false;
      };
      const title = titleEl.value.trim();
      const modelId = modelEl.value.trim();
      const effort = el.querySelector('#ns-effort').value;
      if (!title) return fail(t('session.titleRequired'), titleEl);
      if (!modelId) return fail(t('session.modelRequired'), modelEl);
      try {
        const created = await createSession({ title, modelId, effort });
        storage.set('omnia.ui.lastModel', modelId);
        storage.set('omnia.ui.lastEffort', effort);
        toast({ variant: 'ok', title: t('session.created', { title }) });
        if (created) navigate(buildHash('chat', created.id));
        return true;
      } catch (error) {
        return fail(describeError(error));
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function onGlobalKeydown(event) {
  const mod = event.ctrlKey || event.metaKey;
  const key = (event.key || '').toLowerCase();

  if (mod && !event.altKey && !event.shiftKey && key === 'k') {
    event.preventDefault();
    if (isPaletteOpen()) closePalette();
    else openPalette();
    return;
  }
  if (hasOpenOverlay()) return;

  const inEditor = event.target instanceof Element && event.target.closest('[data-editor]');
  if (mod && !event.altKey && !event.shiftKey && key === 'b' && !inEditor) {
    event.preventDefault();
    toggleSidebar();
    return;
  }
  if (mod && !event.altKey && key === '.') {
    event.preventDefault();
    window.dispatchEvent(new CustomEvent('omnia:toggle-inspector'));
    return;
  }
  if (event.altKey && !mod && /^[1-9]$/.test(event.key)) {
    const view = listViews().find((v) => v.shortcut === event.key);
    if (view) {
      event.preventDefault();
      navigate(`#/${view.id}`);
    }
    return;
  }
  if (event.altKey && !mod && key === 't') {
    event.preventDefault();
    cycleTheme();
    return;
  }
  if (event.key === 'Escape' && ui.drawerOpen) {
    event.preventDefault();
    closeDrawer({ restoreFocus: true });
  }
}

function watchConnection() {
  let previous = connection.get().status;
  connection.subscribe((state) => {
    if (state.status !== previous) {
      if (previous === 'online' && state.status === 'offline') toast({ variant: 'danger', title: t('shell.lostConnection'), message: describeError(state.lastError) });
      if (previous === 'offline' && state.status === 'online') {
        toast({ variant: 'ok', title: t('shell.reconnected') });
        loadSessions();
      }
      previous = state.status;
    }
    paintSoon();
  });
}

function registerAppCommands() {
  registerCommands(() => [
    ...listViews().map((view) => ({
      id: `nav.${view.id}`,
      group: t('palette.groupNav'),
      title: t('palette.open', { name: view.label() }),
      keywords: `${view.id} ${view.label()}`,
      shortcut: view.shortcut ? `Alt ${view.shortcut}` : '',
      icon: view.icon,
      run: () => navigate(`#/${view.id}`)
    })),
    { id: 'app.new-session', group: t('palette.groupApp'), title: t('shell.newSession'), keywords: 'new session phien moi', icon: 'plus', run: openNewSessionDialog },
    { id: 'app.theme', group: t('palette.groupApp'), title: t('shell.themeCycle'), keywords: 'theme dark light giao dien toi sang', icon: 'sun', shortcut: 'Alt T', run: cycleTheme },
    { id: 'app.sidebar', group: t('palette.groupApp'), title: t('palette.toggleSidebar'), keywords: 'sidebar thanh ben', icon: 'panel-left', shortcut: 'Ctrl B', run: toggleSidebar },
    { id: 'app.lang', group: t('palette.groupApp'), title: t('palette.switchLang'), keywords: 'language ngon ngu english tieng viet', icon: 'globe', run: () => prefs.set({ lang: getLang() === 'vi' ? 'en' : 'vi' }) },
    { id: 'app.motion', group: t('palette.groupApp'), title: t('palette.toggleMotion'), keywords: 'motion animation chuyen dong', icon: 'activity', run: () => prefs.set({ reduceMotion: !prefs.get().reduceMotion }) }
  ]);
}

export function startShell() {
  sidebarEl = document.getElementById('omnia-sidebar');
  const scrim = document.querySelector('.drawer-scrim');
  if (scrim) scrim.addEventListener('click', () => closeDrawer());

  on(sidebarEl, 'click', '[data-action]', (event, el) => {
    const action = el.getAttribute('data-action');
    if (action === 'toggle-sidebar') toggleSidebar();
    else if (action === 'new-session') openNewSessionDialog();
    else if (action === 'cycle-theme') cycleTheme();
    else if (action === 'reload-sessions') loadSessions();
    else if (action === 'more-sessions') loadMoreSessions();
    else if (action === 'retry-connection') retryConnection();
  });
  on(sidebarEl, 'click', 'a[href^="#/"]', () => {
    if (!isWide()) closeDrawer();
  });
  on(sidebarEl, 'input', '[data-role="session-filter"]', (event, el) => {
    ui.filter = el.value;
    paintSoon();
  });

  document.addEventListener('keydown', onGlobalKeydown);
  window.addEventListener('resize', debounce(() => {
    if (isWide()) ui.drawerOpen = false;
    applyMode();
    paint();
  }, 120));

  prefs.subscribe(() => {
    applyMode();
    paintSoon();
  });
  sessions.subscribe(paintSoon);
  onLangChange(() => {
    paint();
    refreshRoute();
  });
  onRoute((route) => {
    if (route.view === 'chat' && route.params[0]) setActiveSession(route.params[0]);
    paintSoon();
  });

  watchConnection();
  registerAppCommands();
  applyMode();
  paint();
}
