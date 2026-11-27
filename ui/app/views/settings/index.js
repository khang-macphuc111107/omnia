// Settings view: appearance, language, shortcuts, diagnostics and local data (spec §6.5).

import { registerView, navigate, currentRoute } from '../../core/router.js';
import { registerCommands } from '../../core/palette.js';
import { html, raw, morph, on, batched, cx } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t, fmtNumber, fmtBytes, fmtTime } from '../../core/i18n.js';
import { prefs } from '../../core/prefs.js';
import { rovingFocus, confirmDialog, toast, announce } from '../../core/overlay.js';
import { connection, retryConnection, describeError } from '../../api.js';
import './strings.js';
import {
  THEMES,
  DENSITIES,
  LANGUAGE_OPTIONS,
  THEME_SWATCH,
  SHORTCUTS,
  SECTIONS,
  sectionDomId,
  summarizeLocalChat,
  diagnosticRows,
  connectionMeta
} from './helpers.js';
import { readChatRecords, clearChatRecords, downloadChatExport } from './local-data.js';

let pendingSection = '';

function onSettings() {
  return currentRoute().view === 'settings';
}

function openSection(section) {
  pendingSection = section;
  navigate('#/settings');
}

registerCommands(() => {
  const group = t('settings.cmdGroup');
  const sections = SECTIONS.map((id) => ({
    id: `settings.section-${id}`,
    group,
    title: t('settings.cmdOpenSection', { name: t(`settings.title.${id}`) }),
    keywords: `settings cai dat ${id} ${t(`settings.title.${id}`)}`,
    icon: id === 'keys' ? 'keyboard' : id === 'diag' ? 'activity' : id === 'language' ? 'globe' : id === 'local' ? 'database' : 'sliders',
    run: () => openSection(id)
  }));
  sections.push({
    id: 'settings.recheck',
    group,
    title: t('settings.recheck'),
    keywords: 'health check connection kiem tra lai ket noi',
    icon: 'refresh',
    when: onSettings,
    run: () => retryConnection()
  });
  return sections;
});

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

const LABELS = {
  theme: { dark: 'settings.themeDark', light: 'settings.themeLight', system: 'settings.themeSystem' },
  density: { comfortable: 'settings.densityComfortable', compact: 'settings.densityCompact' }
};

function swatch(id) {
  const [side, main] = THEME_SWATCH[id];
  return html`<span class="settings-swatch" aria-hidden="true"><span class="omnia settings-swatch__side" data-theme="${side}"></span><span class="omnia settings-swatch__main" data-theme="${main}"></span></span>`;
}

function themeCard(id, current) {
  const checked = id === current;
  return html`<button type="button" class="${cx('card card--interactive col settings-theme', { 'settings-theme--on': checked })}" role="radio" data-action="theme" data-value="${id}" data-key="theme:${id}" aria-checked="${checked}" tabindex="${checked ? 0 : -1}">
    ${swatch(id)}
    <span class="row between settings-theme__row"><span class="text-sm strong">${t(LABELS.theme[id])}</span>${checked ? icon('check', { className: 'settings-theme__check' }) : null}</span>
  </button>`;
}

function segItem(action, value, label, current, lang) {
  const checked = value === current;
  return html`<button type="button" class="seg__item" role="radio" data-action="${action}" data-value="${value}" data-key="${action}:${value}" aria-checked="${checked}" tabindex="${checked ? 0 : -1}"${lang ? raw(` lang="${lang}"`) : null}>${label}</button>`;
}

function diagValue(row) {
  switch (row.kind) {
    case 'bytes':
      return html`<span class="num">${fmtBytes(row.value)}</span>`;
    case 'num':
      return html`<span class="mono num">${Number.isFinite(row.value) ? row.value : '—'}</span>`;
    case 'mono':
      return html`<span class="mono">${row.value || '—'}</span>`;
    case 'pair':
      return html`<span class="num">${row.value.map((v) => (Number.isFinite(v) ? fmtNumber(v) : '—')).join(' · ')}</span>`;
    default:
      return html`<span>${row.value || '—'}</span>`;
  }
}

function section(id, titleKey, content, actions = null) {
  const domId = sectionDomId(id);
  return html`<section class="card" aria-labelledby="${domId}-title" id="${domId}">
    <div class="card__header"><h2 class="card__title settings-title" id="${domId}-title" tabindex="-1">${t(titleKey)}</h2>${actions}</div>
    ${content}
  </section>`;
}

function template(view) {
  const p = prefs.get();
  const conn = connection.get();
  const meta = connectionMeta(conn.status);
  const rows = diagnosticRows(conn.health, window.location.host);
  const local = view.local;
  const hasLocal = local.records > 0;

  const appearance = html`<div class="card__body col settings-body">
    <div class="field">
      <span class="field__label" id="settings-theme-label">${t('settings.theme')}</span>
      <div class="row wrap settings-themes" role="radiogroup" aria-labelledby="settings-theme-label" data-roving="theme">${THEMES.map((id) => themeCard(id, p.theme))}</div>
    </div>
    <div class="row between wrap">
      <div class="col settings-label"><span class="field__label" id="settings-density-label">${t('settings.density')}</span><span class="field__hint">${t('settings.densityHint')}</span></div>
      <div class="seg" role="radiogroup" aria-labelledby="settings-density-label" data-roving="density">${DENSITIES.map((id) => segItem('density', id, t(LABELS.density[id]), p.density))}</div>
    </div>
    <div class="row between wrap">
      <div class="col settings-label"><span class="field__label" id="settings-motion-label">${t('settings.motion')}</span><span class="field__hint" id="settings-motion-hint">${t('settings.motionHint')}</span></div>
      <label class="switch"><input type="checkbox" role="switch" data-action="motion" aria-labelledby="settings-motion-label" aria-describedby="settings-motion-hint"${p.reduceMotion ? raw(' checked') : null}><span class="sr-only">${p.reduceMotion ? t('settings.on') : t('settings.off')}</span></label>
    </div>
  </div>`;

  const language = html`<div class="card__body row between wrap">
    <span class="field__hint settings-grow" id="settings-lang-hint">${t('settings.languageHint')}</span>
    <div class="seg" role="radiogroup" aria-label="${t('settings.languageLabel')}" aria-describedby="settings-lang-hint" data-roving="lang">${LANGUAGE_OPTIONS.map((o) => segItem('lang', o.id, o.label, p.lang, o.id))}</div>
  </div>`;

  const keys = html`<div class="table-wrap"><table class="table">
    <caption class="sr-only">${t('settings.title.keys')}</caption>
    <tbody>${SHORTCUTS.map(
      (s) => html`<tr data-key="k:${s.id}"><th scope="row" class="settings-th">${t(`settings.key.${s.id}`)}</th><td class="settings-keys">${s.range ? html`<span class="kbd">${s.keys[0]}</span> … <span class="kbd">${s.keys[1]}</span>` : s.keys.map((k) => html`<span class="kbd">${k}</span> `)}</td></tr>`
    )}</tbody></table></div>`;

  const diagnostics = html`<div class="card__body col settings-body" aria-busy="${view.checking}">
    <div class="row wrap">
      <span class="status status--${meta.variant}">${icon(meta.icon)}${t(meta.labelKey)}</span>
      <span class="text-xs muted">GET /api/health${conn.lastOkAt ? html` · ${t('settings.lastOk')} ${fmtTime(conn.lastOkAt, true)}` : null}</span>
    </div>
    ${conn.status === 'offline'
      ? html`<div class="banner banner--danger" role="alert">${icon('wifi-off', { className: 'banner__icon' })}<div class="banner__body"><span class="banner__title">${t('settings.offlineTitle')}</span><span>${conn.lastError ? describeError(conn.lastError) : t('settings.offlineText')}</span>${conn.health ? html`<span class="text-xs muted">${t('settings.staleNote')}</span>` : null}</div></div>`
      : null}
    ${rows.length
      ? html`<dl class="kv settings-kv${conn.status === 'online' ? '' : ' settings-kv--stale'}">${rows.map((row) => html`<dt data-key="dt:${row.id}">${t(`settings.diag.${row.id}`)}</dt><dd data-key="dd:${row.id}">${diagValue(row)}</dd>`)}</dl>`
      : html`<p class="text-sm muted" role="status">${conn.status === 'connecting' ? t('common.loading') : t('settings.noHealth')}</p>`}
  </div>`;

  const localBody = html`<div class="card__body col settings-body">
    <p class="text-sm subtle">${t('settings.localText')}</p>
    <div class="row wrap">
      <span class="chip num" role="status">${hasLocal ? t('settings.localSummary', { sessions: fmtNumber(local.sessions), messages: fmtNumber(local.messages), size: fmtBytes(local.bytes) }) : t('settings.localEmpty')}</span>
      ${local.unreadable ? html`<span class="status status--warn">${icon('alert')}${t('settings.localUnreadable', { n: fmtNumber(local.unreadable) })}</span>` : null}
      <span class="grow"></span>
      <button type="button" class="btn btn--sm" data-action="export"${hasLocal ? null : raw(' disabled')}>${icon('download', { size: 'sm' })}${t('settings.export')}</button>
      <button type="button" class="btn btn--danger btn--sm" data-action="clear"${hasLocal ? null : raw(' disabled')}>${icon('trash', { size: 'sm' })}${t('settings.clear')}</button>
    </div>
  </div>`;

  const recheck = html`<button type="button" class="btn btn--sm" data-action="recheck" aria-busy="${view.checking}"${view.checking ? raw(' aria-disabled="true"') : null}>${icon('refresh', { size: 'sm' })}${view.checking ? t('settings.checking') : t('settings.recheck')}</button>`;

  return html`<header class="topbar"><h1 class="topbar__title">${t('nav.settings')}</h1></header>
    <div class="scroll fill settings-scroll">
      <div class="col settings-page">
        ${section('appearance', 'settings.title.appearance', appearance)}
        ${section('language', 'settings.title.language', language)}
        ${section('keys', 'settings.title.keys', keys)}
        ${section('diag', 'settings.title.diag', diagnostics, recheck)}
        ${section('local', 'settings.title.local', localBody)}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

registerView({
  id: 'settings',
  order: 5,
  shortcut: '5',
  icon: 'sliders',
  placement: 'footer',
  label: () => t('nav.settings'),
  title: () => t('nav.settings'),
  mount(host) {
    const view = { local: summarizeLocalChat(readChatRecords()), checking: false };

    const paintNow = () => morph(host, template(view));
    const paint = batched(paintNow);
    paintNow();

    const focusTitle = (section) => {
      const heading = document.getElementById(`${sectionDomId(section)}-title`);
      if (!heading) return;
      heading.closest('section')?.scrollIntoView({ block: 'start' });
      heading.focus({ preventScroll: true });
    };

    const consumePending = () => {
      if (!pendingSection) return;
      const section = pendingSection;
      pendingSection = '';
      requestAnimationFrame(() => focusTitle(section));
    };
    consumePending();

    const refreshLocal = () => {
      view.local = summarizeLocalChat(readChatRecords());
    };

    const stops = [
      prefs.subscribe(paint),
      connection.subscribe((state, prev) => {
        if (view.checking) {
          view.checking = false;
          const meta = connectionMeta(state.status);
          announce(t(meta.labelKey));
        } else if (state.status !== prev.status) announce(t(connectionMeta(state.status).labelKey));
        paint();
      })
    ];

    const offs = [
      on(host, 'click', '[data-action]', async (event, el) => {
        const action = el.getAttribute('data-action');
        const value = el.getAttribute('data-value');
        if (action === 'theme') prefs.set({ theme: value });
        else if (action === 'density') prefs.set({ density: value });
        else if (action === 'lang') prefs.set({ lang: value });
        else if (action === 'recheck') {
          if (view.checking) return;
          view.checking = true;
          paint();
          retryConnection();
        } else if (action === 'export') {
          refreshLocal();
          const records = readChatRecords();
          if (!records.length) return paint();
          try {
            const result = downloadChatExport(records);
            toast({ variant: 'ok', title: t('settings.exported'), message: result.name });
            announce(t('settings.exported'));
          } catch (error) {
            toast({ variant: 'danger', title: t('settings.exportFailed'), message: String((error && error.message) || error) });
          }
        } else if (action === 'clear') {
          refreshLocal();
          const ok = await confirmDialog({
            title: t('settings.clearTitle'),
            message: t('settings.clearMessage', { sessions: fmtNumber(view.local.sessions), messages: fmtNumber(view.local.messages), size: fmtBytes(view.local.bytes) }),
            confirmLabel: t('settings.clear'),
            danger: true
          });
          if (!ok) return;
          const result = clearChatRecords();
          refreshLocal();
          paintNow();
          const complete = result.verified && result.remaining === 0 && result.failed === 0;
          const title = t(complete ? 'settings.cleared' : 'settings.clearPartial');
          const message = complete
            ? t('settings.clearedCount', { n: fmtNumber(result.removed) })
            : result.verified
              ? t('settings.clearPartialCount', { removed: fmtNumber(result.removed), remaining: fmtNumber(result.remaining) })
              : t('settings.clearUnverified');
          toast({ variant: complete ? 'ok' : 'danger', title, message });
          announce(`${title}. ${message}`);
          requestAnimationFrame(() => focusTitle('local'));
        }
      }),
      on(host, 'change', 'input[data-action="motion"]', (event, el) => {
        prefs.set({ reduceMotion: el.checked });
        announce(t(el.checked ? 'settings.motionOn' : 'settings.motionOff'));
      }),
      ...Array.from(host.querySelectorAll('[data-roving]')).map((group) =>
        rovingFocus(group, '[role="radio"]', { orientation: 'both', onActivate: (el) => el.click() })
      )
    ];

    return {
      update() {
        refreshLocal();
        paintNow();
        consumePending();
      },
      unmount() {
        stops.forEach((stop) => stop());
        offs.forEach((off) => off());
      }
    };
  }
});
