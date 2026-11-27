// Knowledge → Skills: debounced search over GET /api/skills?q=. Only the latest request
// may update the screen (older ones are aborted and, if they still resolve, ignored).

import { html, morph, on, batched, debounce, cx } from '../../core/dom.js';
import { createStore } from '../../core/store.js';
import { icon } from '../../core/icons.js';
import { t, fmtNumber } from '../../core/i18n.js';
import { announce } from '../../core/overlay.js';
import { api, describeError } from '../../api.js';
import { SKILL_QUICK, normalizeQuery } from './helpers.js';

export const skillsStore = createStore({
  input: '',          // what the search box holds
  query: '',          // query of the last request that was started
  status: 'idle',     // 'idle' | 'loading' | 'ready' | 'error'
  skills: [],
  total: 0,
  catalogTotal: null, // total with an empty query = how many skills exist
  error: null
});

let seq = 0;
let controller = null;
export const SEARCH_ID = 'knowledge-skill-q';

export function skillsCount() {
  return skillsStore.get().catalogTotal;
}

export async function searchSkills(raw = skillsStore.get().input) {
  const query = normalizeQuery(raw);
  const mine = ++seq;
  if (controller) controller.abort();
  controller = new AbortController();
  skillsStore.set({ query, status: 'loading', error: null });
  try {
    const data = await api.skills.search(query, { signal: controller.signal });
    if (mine !== seq) return;
    const skills = Array.isArray(data.skills) ? data.skills : [];
    const total = Number.isFinite(data.total) ? data.total : skills.length;
    skillsStore.set((s) => ({ ...s, status: 'ready', skills, total, error: null, catalogTotal: query === '' ? total : s.catalogTotal }));
    announce(query ? t('knowledge.skillsFound', { count: total, q: query }) : t('knowledge.skillsAll', { count: total }));
  } catch (error) {
    if (mine !== seq || error.code === 'aborted') return;
    skillsStore.set({ status: 'error', error });
    announce(describeError(error));
  }
}

function resultCard(skill, index = 0) {
  return html`<article class="card card--pad card--interactive col gap-3 knowledge-skill enter" data-key="s:${skill.name}" style="--i: ${Math.min(index, 12)}">
    <div class="row between gap-3"><span class="mono strong truncate" title="${skill.name}">${skill.name}</span><span class="text-xs muted num" title="${t('knowledge.score')}">${fmtNumber(skill.score, { minimumFractionDigits: 1, maximumFractionDigits: 2 })}</span></div>
    ${skill.category ? html`<span class="chip knowledge-skill__cat">${skill.category}</span>` : null}
    <p class="text-sm subtle knowledge-content">${skill.description}</p>
    <span class="text-xs muted mono truncate" title="${skill.path}">${skill.path}</span>
  </article>`;
}

function body(state) {
  if (state.status === 'idle' || (state.status === 'loading' && state.skills.length === 0 && state.catalogTotal === null && !state.query)) {
    return html`<div class="knowledge-skill-grid" role="status" aria-label="${t('common.loading')}">${[0, 1, 2, 3, 4, 5].map(() => html`<div class="card card--pad col gap-3"><span class="skeleton knowledge-skel knowledge-skel--wide"></span><span class="skeleton knowledge-skel"></span><span class="skeleton knowledge-skel knowledge-skel--short"></span></div>`)}</div>`;
  }
  if (state.status === 'error') {
    return html`<div class="card empty">
      <span class="empty__icon knowledge-icon--danger">${icon('alert', { size: 'lg' })}</span>
      <p class="empty__title">${t('knowledge.skillsFailed')}</p>
      <p class="empty__text">${describeError(state.error)} <span class="mono">GET /api/skills</span></p>
      <button type="button" class="btn btn--sm" data-action="retry">${icon('refresh', { size: 'sm' })}${t('common.retry')}</button>
    </div>`;
  }
  if (state.status === 'ready' && state.skills.length === 0) {
    return html`<div class="card empty">
      <span class="empty__icon">${icon('search', { size: 'lg' })}</span>
      <p class="empty__title">${state.query ? t('knowledge.skillsNoneFor', { q: state.query }) : t('knowledge.skillsNone')}</p>
      <p class="empty__text">${t('knowledge.skillsNoneHint')}</p>
      ${state.query ? html`<button type="button" class="btn btn--sm" data-action="clear">${t('common.clear')}</button>` : null}
    </div>`;
  }
  return html`<div class="knowledge-skill-grid">${state.skills.map((skill, i) => resultCard(skill, i))}</div>`;
}

function template() {
  const state = skillsStore.get();
  const summary =
    state.status === 'ready'
      ? state.query
        ? t('knowledge.skillsFound', { count: state.total, q: state.query })
        : t('knowledge.skillsAll', { count: state.total })
      : state.status === 'loading'
        ? t('common.loading')
        : '';
  return html`<section class="scroll fill" aria-label="${t('knowledge.tabSkills')}">
    <div class="col gap-4 knowledge-page">
      <div class="input-group">
        ${icon('search')}
        <input class="input knowledge-search" id="${SEARCH_ID}" type="search" value="${state.input}" placeholder="${t('knowledge.skillsPlaceholder')}" aria-label="${t('knowledge.skillsLabel')}" aria-controls="knowledge-skill-results" autocomplete="off" spellcheck="false">
      </div>
      <div class="row wrap">
        ${SKILL_QUICK.map((q) => html`<button type="button" class="${cx('chip knowledge-quick', { 'chip--accent': state.query === q.query })}" data-action="quick" data-query="${q.query}" aria-pressed="${state.query === q.query}">${t(q.labelKey)}</button>`)}
        <span class="grow"></span>
        <span class="text-xs muted" role="status">${summary}</span>
      </div>
      <div id="knowledge-skill-results" aria-busy="${state.status === 'loading'}">${body(state)}</div>
    </div>
  </section>`;
}

export function mountSkills(host, { focusSearch = false } = {}) {
  const root = document.createElement('div');
  root.className = 'knowledge-skills';
  host.append(root);

  const paint = batched(() => morph(root, template()));
  const stop = skillsStore.subscribe(paint);
  paint();

  const run = debounce(() => searchSkills(), 200);
  const state = skillsStore.get();
  // Search on first visit (or after an error); otherwise show the cached list immediately.
  if (state.status === 'idle' || state.status === 'error' || state.status === 'loading') searchSkills(state.input);
  if (focusSearch) requestAnimationFrame(() => document.getElementById(SEARCH_ID)?.focus());

  const offs = [
    on(root, 'input', `#${SEARCH_ID}`, (event, el) => {
      skillsStore.set({ input: el.value });
      run();
    }),
    on(root, 'keydown', `#${SEARCH_ID}`, (event, el) => {
      if (event.key === 'Enter' && !event.isComposing) {
        run.cancel();
        searchSkills(el.value);
      }
    }),
    on(root, 'click', '[data-action]', (event, el) => {
      const action = el.getAttribute('data-action');
      if (action === 'quick') {
        const query = el.getAttribute('data-query');
        run.cancel();
        skillsStore.set({ input: query });
        searchSkills(query);
      } else if (action === 'clear') {
        run.cancel();
        skillsStore.set({ input: '' });
        searchSkills('');
        document.getElementById(SEARCH_ID)?.focus();
      } else if (action === 'retry') {
        searchSkills(skillsStore.get().input);
      }
    })
  ];

  return {
    refresh: () => morph(root, template()),
    unmount() {
      run.cancel();
      stop();
      offs.forEach((off) => off());
      if (controller) controller.abort();
      seq += 1; // drop any response that is still in flight
      if (skillsStore.get().status === 'loading') skillsStore.set({ status: 'idle' });
      root.remove();
    }
  };
}
