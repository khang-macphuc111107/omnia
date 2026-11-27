// Knowledge → Memory: namespace tree, entry cards, erasure receipts and the upsert form.
// Server state (entries, erasures) and form state live in module-level stores so a tab
// switch or a remount keeps what the user typed; subscriptions are per mount.

import { html, raw, morph, on, batched, cx } from '../../core/dom.js';
import { createStore } from '../../core/store.js';
import { icon } from '../../core/icons.js';
import { t, fmtRelative, fmtDateTime, fmtNumber } from '../../core/i18n.js';
import { rovingFocus, confirmDialog, toast, announce, copyText } from '../../core/overlay.js';
import { api, connection, describeError } from '../../api.js';
import {
  buildNamespaceTree,
  filterEntries,
  shortSha,
  tierMeta,
  validateMemoryForm,
  offendingChars,
  mergeReceipts
} from './helpers.js';

export const memoryStore = createStore({ status: 'idle', entries: [], erasures: [], error: null, refreshing: false });

function emptyForm() {
  return { namespace: '', key: '', tier: 'Durable', content: '', touched: { namespace: false, key: false }, editing: '' };
}

const ui = createStore({ nsPath: '', text: '', highlightId: '', form: emptyForm(), saving: false, serverError: '', erasingId: '' });
let loadSeq = 0;
let flashTimer = null;

export function memoryCount() {
  const { status, entries } = memoryStore.get();
  return status === 'ready' ? entries.length : null;
}

export async function loadMemory() {
  const seq = ++loadSeq;
  const hasData = memoryStore.get().status === 'ready';
  memoryStore.set(hasData ? { refreshing: true } : { status: 'loading', error: null });
  try {
    const data = await api.memory.list();
    if (seq !== loadSeq) return;
    memoryStore.set({ status: 'ready', entries: data.entries || [], erasures: mergeReceipts(data.erasures), error: null, refreshing: false });
  } catch (error) {
    if (seq !== loadSeq || error.code === 'aborted') return;
    memoryStore.set({ status: hasData ? 'ready' : 'error', error, refreshing: false });
  }
}

/** Keep the visible snapshot current, including restarts between two healthy probes. */
export function watchMemory() {
  const stop = connection.subscribe((state, prev) => {
    if (state.status === 'offline' && prev.status !== 'offline' && memoryStore.get().status === 'ready') {
      memoryStore.set({ error: state.lastError });
    }
    const restarted = prev.health?.pid && state.health?.pid && prev.health.pid !== state.health.pid;
    if (state.status === 'online' && (prev.status === 'offline' || restarted)) void loadMemory();
  });
  void loadMemory();
  return stop;
}

function flash(id) {
  clearTimeout(flashTimer);
  ui.set({ highlightId: id });
  flashTimer = setTimeout(() => ui.set({ highlightId: '' }), 2600);
}

// ---------------------------------------------------------------------------
// Form helpers
// ---------------------------------------------------------------------------

function patchForm(patch) {
  ui.set((s) => ({ ...s, serverError: '', form: { ...s.form, ...patch } }));
}

function issueText(field, value, code) {
  if (!code) return '';
  const params = { field: t(field === 'key' ? 'knowledge.fieldKey' : 'knowledge.fieldNamespace'), chars: offendingChars(value) };
  return t(`knowledge.issue.${code}`, params);
}

function formView(state) {
  const { form } = state;
  const issues = validateMemoryForm(form);
  const shown = {};
  for (const field of ['namespace', 'key']) {
    const code = issues[field];
    const visible = code && (form.touched[field] || (form[field] !== '' && code !== 'empty'));
    shown[field] = visible ? issueText(field, form[field], code) : '';
  }
  const id = `${form.namespace}/${form.key}`;
  const overwrites = issues.valid && memoryStore.get().entries.some((entry) => entry.id === id);
  return { issues, shown, overwrites };
}

function entryToForm(entry) {
  return { namespace: entry.namespace, key: entry.key, tier: entry.tier === 'Working' ? 'Working' : 'Durable', content: entry.content || '', touched: { namespace: false, key: false }, editing: entry.id };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function loadingList() {
  return html`<div class="col gap-3" role="status" aria-label="${t('common.loading')}">
    ${[0, 1, 2].map(
      () => html`<div class="card card--pad col gap-3"><span class="skeleton knowledge-skel knowledge-skel--wide"></span><span class="skeleton knowledge-skel"></span><span class="skeleton knowledge-skel knowledge-skel--short"></span></div>`
    )}
  </div>`;
}

function errorState(error) {
  return html`<div class="card empty">
    <span class="empty__icon knowledge-icon--danger">${icon('alert', { size: 'lg' })}</span>
    <p class="empty__title">${t('knowledge.loadFailedMemory')}</p>
    <p class="empty__text">${describeError(error)} <span class="mono">GET /api/memory</span></p>
    <button type="button" class="btn btn--sm" data-action="reload">${icon('refresh', { size: 'sm' })}${t('common.retry')}</button>
  </div>`;
}

function entryCard(entry, highlightId, index = 0, erasingId = '') {
  const tier = tierMeta(entry.tier);
  const links = entry.links || [];
  const flashing = entry.id === highlightId;
  return html`<article class="${cx('card card--pad col gap-3 knowledge-entry enter', { 'knowledge-entry--flash': flashing })}" data-key="e:${entry.id}" style="--i: ${Math.min(index, 12)}" aria-label="${entry.id}">
    <div class="row between wrap">
      <span class="mono text-sm knowledge-entry__id"><span class="muted">${entry.namespace}/</span><span class="strong">${entry.key}</span></span>
      <span class="status status--${tier.variant}">${icon(tier.icon)}${t(tier.labelKey)}</span>
    </div>
    <p class="text-sm knowledge-content">${entry.content || t('knowledge.emptyContent')}</p>
    ${links.length
      ? html`<div class="row wrap gap-2">
          <span class="text-xs muted">${t('knowledge.links')}</span>
          ${links.map(
            (link) => html`<button type="button" class="chip chip--mono knowledge-link" data-action="link" data-id="${link}" title="${t('knowledge.linkFilter', { id: link })}">${icon('link', { size: 'sm' })}<span class="truncate">${link}</span></button>`
          )}
        </div>`
      : null}
    <div class="row between wrap">
      <span class="text-xs muted mono" title="${entry.contentSha256}">sha256 ${shortSha(entry.contentSha256)} · <span title="${fmtDateTime(entry.updatedAt)}">${fmtRelative(entry.updatedAt)}</span></span>
      <div class="row">
        <button type="button" class="btn btn--ghost btn--sm" data-action="edit" data-id="${entry.id}" aria-label="${t('knowledge.editEntry', { id: entry.id })}">${icon('edit', { size: 'sm' })}${t('knowledge.edit')}</button>
        <button type="button" class="btn btn--ghost btn--sm knowledge-danger" data-action="erase" data-id="${entry.id}"${entry.id === erasingId ? raw(' aria-busy="true"') : null} aria-label="${t('knowledge.eraseEntry', { id: entry.id })}">${icon('trash', { size: 'sm' })}${t('common.delete')}</button>
      </div>
    </div>
  </article>`;
}

function receiptsCard(receipts) {
  return html`<section class="card" aria-labelledby="knowledge-receipts-title">
    <div class="card__header">
      <h2 class="card__title" id="knowledge-receipts-title">${t('knowledge.receipts')}</h2>
      <span class="text-xs muted">${t('knowledge.receiptsNote')}</span>
    </div>
    ${receipts.length === 0
      ? html`<div class="empty knowledge-empty-compact"><p class="empty__text">${t('knowledge.receiptsEmpty')}</p></div>`
      : html`<ul class="knowledge-receipts">
          ${receipts.map(
            (r) => html`<li class="knowledge-receipt col gap-2 enter" data-key="r:${r.receiptId}">
              <div class="row between wrap">
                <span class="mono text-sm strong">${r.receiptId}</span>
                <span class="${r.verifiedPlaintextFree ? 'status status--ok' : 'status status--warn'}">${icon(r.verifiedPlaintextFree ? 'shield' : 'alert')}${t(r.verifiedPlaintextFree ? 'knowledge.plaintextFree' : 'knowledge.plaintextUnverified')}</span>
              </div>
              <dl class="kv">
                <dt>${t('knowledge.erasedId')}</dt><dd class="mono">${r.erasedId}</dd>
                <dt>Namespace</dt><dd class="mono">${r.namespace}</dd>
                <dt>${t('knowledge.prevDigest')}</dt>
                <dd class="row gap-2"><span class="mono truncate" title="${r.previousDigestSha256}">${shortSha(r.previousDigestSha256)}</span>
                  <button type="button" class="btn btn--ghost btn--icon btn--sm" data-action="copy" data-value="${r.previousDigestSha256}" aria-label="${t('knowledge.copyDigest', { id: r.receiptId })}">${icon('copy', { size: 'sm' })}</button></dd>
                <dt>${t('knowledge.erasedAt')}</dt><dd><span title="${fmtDateTime(r.erasedAt)}">${fmtRelative(r.erasedAt)}</span></dd>
              </dl>
            </li>`
          )}
        </ul>`}
  </section>`;
}

function namespaceNav(tree, total, nsPath) {
  const item = (path, label, count, depth) => html`<button type="button" class="nav-item knowledge-ns-item" data-key="n:${path}" data-action="ns" data-path="${path}" style="--depth: ${depth}"${path === nsPath ? raw(' aria-current="page"') : null}>
    <span class="${depth ? 'mono text-xs truncate' : 'truncate'}">${label}</span><span class="count">${fmtNumber(count)}</span></button>`;
  return html`<nav class="pane scroll knowledge-ns" aria-label="${t('knowledge.namespaces')}">
    <span class="section-title knowledge-ns__title">${t('knowledge.namespaces')}</span>
    ${item('', t('knowledge.all'), total, 0)}
    ${tree.map((node) => item(node.path, node.name, node.count, node.depth))}
  </nav>`;
}

const NBSP2 = String.fromCharCode(0xa0, 0xa0);

function namespaceSelect(tree, total, nsPath) {
  return html`<select class="select knowledge-ns-select" data-action-change="ns" aria-label="${t('knowledge.namespaces')}">
    <option value=""${nsPath === '' ? raw(' selected') : null}>${t('knowledge.all')} (${fmtNumber(total)})</option>
    ${tree.map((n) => html`<option value="${n.path}"${n.path === nsPath ? raw(' selected') : null}>${NBSP2.repeat(n.depth)}${n.name} (${fmtNumber(n.count)})</option>`)}
  </select>`;
}

function formPanel(state) {
  const { form, saving, serverError } = state;
  const { issues, shown, overwrites } = formView(state);
  const describe = (field) => `knowledge-mem-${field}-hint${shown[field] ? ` knowledge-mem-${field}-err` : ''}`;
  return html`<aside class="panel scroll knowledge-form" aria-label="${t('knowledge.formTitle')}">
    <div class="panel__header"><h2 class="panel__title">${form.editing ? t('knowledge.formEdit') : t('knowledge.formTitle')}</h2></div>
    <form class="panel__section knowledge-form__body" novalidate data-form="memory">
      <div class="field">
        <label class="field__label" for="knowledge-mem-namespace">${t('knowledge.fieldNamespace')}</label>
        <input class="input input--mono" id="knowledge-mem-namespace" name="namespace" type="text" value="${form.namespace}" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="256" aria-invalid="${Boolean(shown.namespace)}" aria-describedby="${describe('namespace')}" aria-required="true" placeholder="architecture/cpp20-core">
        <span class="field__hint" id="knowledge-mem-namespace-hint">${t('knowledge.hintNamespace')}</span>
        ${shown.namespace ? html`<span class="field__error" id="knowledge-mem-namespace-err">${icon('alert-circle', { size: 'sm' })}${shown.namespace}</span>` : null}
      </div>
      <div class="field">
        <label class="field__label" for="knowledge-mem-key">${t('knowledge.fieldKey')}</label>
        <input class="input input--mono" id="knowledge-mem-key" name="key" type="text" value="${form.key}" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="64" aria-invalid="${Boolean(shown.key)}" aria-describedby="${describe('key')}" aria-required="true" placeholder="winsqlite3-wal-lease">
        <span class="field__hint" id="knowledge-mem-key-hint">${t('knowledge.hintKey')}</span>
        ${shown.key ? html`<span class="field__error" id="knowledge-mem-key-err">${icon('alert-circle', { size: 'sm' })}${shown.key}</span>` : null}
      </div>
      <div class="field">
        <span class="field__label" id="knowledge-mem-tier-label">${t('knowledge.fieldTier')}</span>
        <div class="seg" role="radiogroup" aria-labelledby="knowledge-mem-tier-label" data-roving="tier">
          ${['Durable', 'Working'].map(
            (tier) => html`<button type="button" class="seg__item" role="radio" data-action="tier" data-tier="${tier}" aria-checked="${form.tier === tier}" tabindex="${form.tier === tier ? 0 : -1}">${t(tierMeta(tier).labelKey)}</button>`
          )}
        </div>
      </div>
      <div class="field">
        <label class="field__label" for="knowledge-mem-content">${t('knowledge.fieldContent')}</label>
        <textarea class="textarea" id="knowledge-mem-content" name="content" rows="7" data-controlled aria-describedby="knowledge-mem-content-hint" placeholder="${t('knowledge.contentPlaceholder')}">${raw('\n')}${form.content}</textarea>
        <span class="field__hint" id="knowledge-mem-content-hint">${t('knowledge.hintContent')} <span class="kbd">Ctrl Enter</span></span>
      </div>
      ${overwrites ? html`<p class="banner banner--info knowledge-form__note" role="status">${icon('info', { size: 'sm', className: 'banner__icon' })}<span class="banner__body">${t('knowledge.overwrites', { id: `${form.namespace}/${form.key}` })}</span></p>` : null}
      ${serverError ? html`<p class="banner banner--danger knowledge-form__note" role="alert">${icon('stop', { size: 'sm', className: 'banner__icon' })}<span class="banner__body"><span class="banner__title">${t('knowledge.saveFailed')}</span><span>${serverError}</span></span></p>` : null}
      <div class="row knowledge-form__actions">
        <button type="button" class="btn btn--ghost" data-action="reset-form">${t('knowledge.clearForm')}</button>
        <button type="submit" class="btn btn--primary"${issues.valid && !saving ? null : raw(' disabled')}${saving ? raw(' aria-busy="true"') : null}>${saving ? t('knowledge.saving') : t('common.save')}</button>
      </div>
    </form>
  </aside>`;
}

function listSection(state, mem) {
  const { nsPath, text, highlightId } = state;
  const visible = filterEntries(mem.entries, { namespace: nsPath, text });
  const filtered = Boolean(nsPath || text);
  let body;
  if (mem.status === 'loading' || mem.status === 'idle') body = loadingList();
  else if (mem.status === 'error') body = errorState(mem.error);
  else if (mem.entries.length === 0) {
    body = html`<div class="card empty">
      <span class="empty__icon">${icon('database', { size: 'lg' })}</span>
      <p class="empty__title">${t('knowledge.emptyTitle')}</p>
      <p class="empty__text">${t('knowledge.emptyText')}</p>
    </div>`;
  } else if (visible.length === 0) {
    body = html`<div class="card empty">
      <span class="empty__icon">${icon('search', { size: 'lg' })}</span>
      <p class="empty__title">${t('knowledge.noMatchTitle')}</p>
      <p class="empty__text">${t('knowledge.noMatchText')}</p>
      <button type="button" class="btn btn--sm" data-action="clear-filter">${t('common.clear')}</button>
    </div>`;
  } else body = html`<div class="col gap-4">${visible.map((entry, i) => entryCard(entry, highlightId, i, state.erasingId))}</div>`;

  const countLabel = mem.status === 'ready' ? t('knowledge.entryCount', { count: visible.length }) : t('knowledge.entries');
  return html`<section class="pane fill scroll knowledge-list" aria-label="${t('knowledge.entries')}" aria-busy="${mem.status === 'loading' || mem.refreshing}">
    <div class="col gap-4 knowledge-list__inner">
      <div class="row between wrap">
        <h2 class="strong knowledge-list__title" tabindex="-1" data-focus="list">${countLabel}</h2>
        <div class="row wrap">
          ${namespaceSelect(buildNamespaceTree(mem.entries), mem.entries.length, nsPath)}
          <div class="input-group knowledge-filter">
            ${icon('search', { size: 'sm' })}
            <input class="input" id="knowledge-mem-filter" type="search" value="${text}" placeholder="${t('knowledge.filterPlaceholder')}" aria-label="${t('knowledge.filterLabel')}" autocomplete="off" spellcheck="false">
          </div>
          <button type="button" class="btn btn--ghost btn--icon" data-action="reload" aria-label="${t('common.refresh')}" title="${t('common.refresh')}">${icon('refresh')}</button>
        </div>
      </div>
      ${filtered && mem.status === 'ready'
        ? html`<div class="row wrap gap-2">
            ${nsPath ? html`<span class="chip chip--mono chip--accent">${icon('filter', { size: 'sm' })}${nsPath}</span>` : null}
            ${text ? html`<span class="chip chip--accent">${icon('search', { size: 'sm' })}${text}</span>` : null}
            <button type="button" class="btn btn--ghost btn--sm" data-action="clear-filter">${icon('x', { size: 'sm' })}${t('common.clear')}</button>
          </div>`
        : null}
      ${mem.status === 'ready' && mem.error
        ? html`<p class="banner banner--warn" role="status">${icon('alert', { className: 'banner__icon' })}<span class="banner__body">${t('knowledge.memoryStale')} ${describeError(mem.error)}</span></p>`
        : null}
      ${body}
      ${receiptsCard(mem.erasures)}
    </div>
  </section>`;
}

function template() {
  const state = ui.get();
  const mem = memoryStore.get();
  const tree = buildNamespaceTree(mem.entries);
  return html`${namespaceNav(tree, mem.entries.length, state.nsPath)}${listSection(state, mem)}${formPanel(state)}`;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountMemory(body) {
  const root = document.createElement('div');
  root.className = 'knowledge-memory';
  body.append(root);
  ui.set({ highlightId: '' });

  const paint = batched(() => morph(root, template()));
  const stops = [memoryStore.subscribe(paint), ui.subscribe(paint), watchMemory()];
  paint();

  const focusSoon = (selector) => requestAnimationFrame(() => root.querySelector(selector)?.focus());

  async function erase(id) {
    const ok = await confirmDialog({
      title: t('knowledge.eraseTitle'),
      message: t('knowledge.eraseMessage', { id }),
      confirmLabel: t('common.delete'),
      danger: true
    });
    if (!ok) return;
    ui.set({ erasingId: id });
    try {
      const { receipt } = await api.memory.erase({ id });
      if (receipt) memoryStore.set((s) => ({ ...s, entries: s.entries.filter((entry) => entry.id !== id), erasures: mergeReceipts(s.erasures, [receipt]) }));
      if (ui.get().form.editing === id) patchForm({ editing: '' });
      toast({ variant: 'ok', title: t('knowledge.erased'), message: id });
      announce(t('knowledge.erased') + ' ' + id);
      await loadMemory();
      ui.set({ erasingId: '' });
      focusSoon('[data-focus="list"]');
    } catch (error) {
      ui.set({ erasingId: '' });
      toast({ variant: 'danger', title: t('knowledge.eraseFailed'), message: describeError(error) });
      if (error.code === 'memory_entry_not_found') loadMemory();
    }
  }

  async function save() {
    const state = ui.get();
    const { form } = state;
    const { issues } = formView(state);
    if (state.saving) return;
    if (!issues.valid) {
      patchForm({ touched: { namespace: true, key: true } });
      focusSoon(issues.namespace ? '#knowledge-mem-namespace' : '#knowledge-mem-key');
      return;
    }
    ui.set({ saving: true, serverError: '' });
    try {
      const data = await api.memory.upsert({ namespace: form.namespace, key: form.key, content: form.content, tier: form.tier });
      const entry = data.entry;
      memoryStore.set((s) => ({ ...s, status: 'ready', error: null, entries: data.entries || s.entries }));
      ui.set((s) => ({
        ...s,
        saving: false,
        nsPath: filterEntries([entry], { namespace: s.nsPath, text: s.text }).length ? s.nsPath : '',
        text: filterEntries([entry], { namespace: s.nsPath, text: s.text }).length ? s.text : '',
        form: { ...s.form, editing: entry ? entry.id : s.form.editing }
      }));
      if (entry) {
        flash(entry.id);
        requestAnimationFrame(() => root.querySelector(`[data-key="e:${CSS.escape(entry.id)}"]`)?.scrollIntoView({ block: 'nearest' }));
      }
      toast({ variant: 'ok', title: t('knowledge.saved'), message: entry ? entry.id : '' });
      announce(t('knowledge.saved') + (entry ? ` ${entry.id}` : ''));
    } catch (error) {
      ui.set({ saving: false, serverError: describeError(error) });
    }
  }

  const offs = [
    on(root, 'click', '[data-action]', (event, el) => {
      const action = el.getAttribute('data-action');
      const id = el.getAttribute('data-id');
      switch (action) {
        case 'ns':
          ui.set({ nsPath: el.getAttribute('data-path') || '' });
          break;
        case 'link':
          ui.set({ nsPath: '', text: id });
          focusSoon('[data-focus="list"]');
          announce(t('knowledge.linkFilter', { id }));
          break;
        case 'clear-filter':
          ui.set({ nsPath: '', text: '' });
          break;
        case 'reload':
          loadMemory();
          break;
        case 'edit': {
          const entry = memoryStore.get().entries.find((e) => e.id === id);
          if (!entry) break;
          ui.set({ serverError: '', form: entryToForm(entry) });
          requestAnimationFrame(() => {
            const area = root.querySelector('#knowledge-mem-content');
            area?.scrollIntoView({ block: 'nearest' });
            area?.focus();
          });
          announce(t('knowledge.editing', { id }));
          break;
        }
        case 'erase':
          erase(id);
          break;
        case 'copy':
          copyText(el.getAttribute('data-value') || '').then((ok) => toast({ variant: ok ? 'info' : 'warn', title: ok ? t('common.copied') : t('knowledge.copyFailed') }));
          break;
        case 'tier':
          patchForm({ tier: el.getAttribute('data-tier') });
          break;
        case 'reset-form':
          ui.set({ serverError: '', form: emptyForm() });
          focusSoon('#knowledge-mem-namespace');
          break;
        default:
      }
    }),
    on(root, 'change', '[data-action-change="ns"]', (event, el) => ui.set({ nsPath: el.value })),
    on(root, 'input', 'input, textarea', (event, el) => {
      if (el.id === 'knowledge-mem-filter') ui.set({ text: el.value });
      else if (el.id === 'knowledge-mem-namespace') patchForm({ namespace: el.value });
      else if (el.id === 'knowledge-mem-key') patchForm({ key: el.value });
      else if (el.id === 'knowledge-mem-content') patchForm({ content: el.value });
    }),
    on(root, 'focusout', '#knowledge-mem-namespace, #knowledge-mem-key', (event, el) => {
      const field = el.name;
      if (!ui.get().form.touched[field]) patchForm({ touched: { ...ui.get().form.touched, [field]: true } });
    }),
    on(root, 'submit', 'form[data-form="memory"]', (event) => {
      event.preventDefault();
      save();
    }),
    on(root, 'keydown', '#knowledge-mem-content', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
        save();
      }
    }),
    rovingFocus(root, '[data-roving="tier"] .seg__item', { onActivate: (el) => el.click() })
  ];

  return {
    refresh: () => morph(root, template()),
    unmount() {
      stops.forEach((stop) => stop());
      offs.forEach((off) => off());
      clearTimeout(flashTimer);
      ui.set({ highlightId: '' });
      root.remove();
    }
  };
}
