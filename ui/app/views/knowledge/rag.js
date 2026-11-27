// Knowledge → RAG planner: POST /api/rag/plan decides whether retrieval is needed and
// which sources would be cited. The previous result stays on screen while a new one loads.

import { html, raw, morph, on, batched, cx } from '../../core/dom.js';
import { createStore } from '../../core/store.js';
import { icon } from '../../core/icons.js';
import { t, fmtNumber } from '../../core/i18n.js';
import { announce } from '../../core/overlay.js';
import { api, describeError } from '../../api.js';
import { RAG_SAMPLES, uncertaintyPercent, provenanceVariant, languageLabelKey, humanizeCode } from './helpers.js';

export const ragStore = createStore({
  query: '',
  status: 'idle', // 'idle' | 'loading' | 'ready' | 'error'
  result: null,
  error: null,
  invalid: false  // the last submit had an empty query
});

export const QUERY_ID = 'knowledge-rag-q';
let seq = 0;
let controller = null;

export function ragQueryPresent() {
  return ragStore.get().query.trim() !== '';
}

export async function runRag() {
  const query = ragStore.get().query.trim();
  if (!query) {
    ragStore.set({ invalid: true });
    requestAnimationFrame(() => document.getElementById(QUERY_ID)?.focus());
    announce(t('knowledge.ragEmpty'));
    return;
  }
  const mine = ++seq;
  if (controller) controller.abort();
  controller = new AbortController();
  ragStore.set({ status: 'loading', error: null, invalid: false });
  try {
    const result = await api.rag.plan({ query }, { signal: controller.signal });
    if (mine !== seq) return;
    ragStore.set({ status: 'ready', result, error: null });
    announce(
      t('knowledge.ragDone', {
        decision: t(result.shouldRetrieve ? 'knowledge.retrieve' : 'knowledge.noRetrieve'),
        sources: (result.citedSources || []).length
      })
    );
  } catch (error) {
    if (mine !== seq || error.code === 'aborted') return;
    ragStore.set({ status: 'error', error });
    announce(describeError(error));
  }
}

function trKey(key, fallback) {
  const text = t(key);
  return text === key ? fallback : text;
}

function score(value) {
  return fmtNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function resultView(result, loading) {
  const percent = uncertaintyPercent(result.uncertaintyScore);
  const triggers = result.triggers || [];
  const subQueries = result.subQueries || [];
  const cited = result.citedSources || [];
  const unused = result.unusedSources || [];
  const lang = result.language;
  return html`<div class="col gap-4 enter" aria-busy="${loading}" data-result data-key="rag-result">
    <section class="card card--pad col gap-3" aria-label="${t('knowledge.ragDecision')}">
      <div class="row between wrap">
        <div class="row wrap">
          ${result.shouldRetrieve
            ? html`<span class="status status--accent">${icon('search')}${t('knowledge.retrieve')}</span>`
            : html`<span class="status status--info">${icon('check')}${t('knowledge.noRetrieve')}</span>`}
          <span class="chip" lang="${lang === 'vi' || lang === 'en' ? lang : null}">${t('knowledge.language')}: ${t(languageLabelKey(lang))}</span>
        </div>
        <span class="text-sm" id="knowledge-uncertainty-label">${t('knowledge.uncertainty')} <span class="strong num">${score(result.uncertaintyScore)}</span></span>
      </div>
      <div class="meter knowledge-meter" role="meter" aria-labelledby="knowledge-uncertainty-label" aria-valuemin="0" aria-valuemax="1" aria-valuenow="${Number(result.uncertaintyScore) || 0}" aria-valuetext="${score(result.uncertaintyScore)}"><div class="meter__fill meter__fill--accent" style="width: ${percent}%"></div></div>
      <div class="row wrap">
        <span class="text-xs muted">${t('knowledge.triggers')}</span>
        ${triggers.length ? triggers.map((trigger) => html`<span class="chip chip--mono">${trigger}</span>`) : html`<span class="text-xs muted">${t('common.none')}</span>`}
      </div>
    </section>

    <section class="col gap-3" aria-labelledby="knowledge-sub-title">
      <h2 class="strong" id="knowledge-sub-title">${t('knowledge.subQueries')} · ${fmtNumber(subQueries.length)}</h2>
      ${subQueries.length
        ? html`<ol class="knowledge-list-plain">${subQueries.map((q, i) => html`<li class="card knowledge-subquery enter" data-key="q:${i}" style="--i: ${Math.min(i, 12)}"><span class="text-xs muted">${trKey(`knowledge.angle.${q.angle}`, humanizeCode(q.angle))}</span><p class="text-sm">${q.query}</p></li>`)}</ol>`
        : html`<p class="text-sm muted">${t('knowledge.subQueriesNone')}</p>`}
    </section>

    <div class="knowledge-sources">
      <section class="col gap-3" aria-labelledby="knowledge-cited-title">
        <h2 class="strong" id="knowledge-cited-title">${t('knowledge.cited')} · ${fmtNumber(cited.length)}</h2>
        ${cited.length
          ? cited.map(
              (s) => html`<article class="card card--pad col gap-2 enter" data-key="c:${s.id}">
                <div class="row between gap-3"><span class="strong text-sm">${s.title}</span><span class="status${provenanceVariant(s.provenance) ? ` status--${provenanceVariant(s.provenance)}` : ''}">${s.provenance} · ${score(s.score)}</span></div>
                <span class="mono text-xs muted knowledge-locator">${s.locator}</span>
                <p class="text-sm subtle">${s.snippet}</p>
              </article>`
            )
          : html`<div class="card empty knowledge-empty-compact"><p class="empty__text">${t('knowledge.citedNone')}</p></div>`}
      </section>
      <section class="col gap-3" aria-labelledby="knowledge-unused-title">
        <h2 class="strong" id="knowledge-unused-title">${t('knowledge.unused')} · ${fmtNumber(unused.length)}</h2>
        ${unused.length
          ? unused.map(
              (s) => html`<article class="card card--pad col gap-2 knowledge-unused enter" data-key="u:${s.id}">
                <div class="row between gap-3"><span class="strong text-sm">${s.title}</span><span class="status status--warn">${trKey(`knowledge.reason.${s.reason}`, humanizeCode(s.reason))}</span></div>
                <span class="mono text-xs muted knowledge-locator">${s.locator}</span>
                <span class="text-xs muted mono">${s.reason}</span>
              </article>`
            )
          : html`<div class="card empty knowledge-empty-compact"><p class="empty__text">${t('knowledge.unusedNone')}</p></div>`}
      </section>
    </div>
  </div>`;
}

function template() {
  const state = ragStore.get();
  const loading = state.status === 'loading';
  let output;
  if (state.result) output = resultView(state.result, loading);
  else if (loading) {
    output = html`<div class="card card--pad col gap-3" role="status" aria-label="${t('common.loading')}"><span class="skeleton knowledge-skel knowledge-skel--wide"></span><span class="skeleton knowledge-skel"></span><span class="skeleton knowledge-skel knowledge-skel--short"></span></div>`;
  } else if (state.status !== 'error') {
    output = html`<div class="card empty"><span class="empty__icon">${icon('search', { size: 'lg' })}</span><p class="empty__title">${t('knowledge.ragIdleTitle')}</p><p class="empty__text">${t('knowledge.ragIdleText')}</p></div>`;
  }
  return html`<section class="scroll fill" aria-label="${t('knowledge.tabRag')}">
    <div class="col gap-4 knowledge-page">
      <form class="card card--pad col gap-3" data-form="rag" novalidate>
        <div class="field">
          <label class="field__label" for="${QUERY_ID}">${t('knowledge.ragLabel')}</label>
          <textarea class="textarea" id="${QUERY_ID}" rows="3" aria-invalid="${state.invalid}" aria-describedby="knowledge-rag-hint${state.invalid ? ' knowledge-rag-err' : ''}" aria-required="true" placeholder="${t('knowledge.ragPlaceholder')}">${raw('\n')}${state.query}</textarea>
          <span class="field__hint" id="knowledge-rag-hint">${t('knowledge.ragHint')} <span class="kbd">Ctrl Enter</span></span>
          ${state.invalid ? html`<span class="field__error" id="knowledge-rag-err">${icon('alert-circle', { size: 'sm' })}${t('knowledge.ragEmpty')}</span>` : null}
        </div>
        <div class="row between wrap">
          <div class="row wrap" role="group" aria-label="${t('knowledge.samples')}">
            ${RAG_SAMPLES.map((s) => html`<button type="button" class="chip knowledge-quick" data-action="sample" data-id="${s.id}" title="${s.query}">${t(s.labelKey)}</button>`)}
          </div>
          <button type="submit" class="${cx('btn btn--primary')}"${loading ? html` aria-busy="true"` : null}>${icon('play')}${loading ? t('knowledge.analyzing') : t('knowledge.analyze')}</button>
        </div>
      </form>
      ${state.status === 'error'
        ? html`<div class="banner banner--danger" role="alert">${icon('stop', { className: 'banner__icon' })}<div class="banner__body"><span class="banner__title">${t('knowledge.ragFailed')}</span><span>${describeError(state.error)}</span></div><button type="button" class="btn btn--sm" data-action="run">${t('common.retry')}</button></div>`
        : null}
      ${output || null}
    </div>
  </section>`;
}

export function mountRag(host) {
  const root = document.createElement('div');
  root.className = 'knowledge-rag';
  host.append(root);

  const paint = batched(() => morph(root, template()));
  const stop = ragStore.subscribe((state, prev) => {
    // Do not re-render on every keystroke; only when something visible changed.
    if (state.query !== prev.query && state.status === prev.status && state.invalid === prev.invalid && state.result === prev.result) return;
    paint();
  });
  paint();

  const area = () => document.getElementById(QUERY_ID);
  const offs = [
    on(root, 'input', `#${QUERY_ID}`, (event, el) => {
      const hadError = ragStore.get().invalid;
      ragStore.set({ query: el.value, invalid: hadError && el.value.trim() === '' });
    }),
    on(root, 'keydown', `#${QUERY_ID}`, (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
        runRag();
      }
    }),
    on(root, 'submit', 'form[data-form="rag"]', (event) => {
      event.preventDefault();
      runRag();
    }),
    on(root, 'click', '[data-action]', (event, el) => {
      const action = el.getAttribute('data-action');
      if (action === 'run') runRag();
      else if (action === 'sample') {
        const sample = RAG_SAMPLES.find((s) => s.id === el.getAttribute('data-id'));
        if (!sample) return;
        ragStore.set({ query: sample.query, invalid: false });
        const field = area();
        if (field) {
          field.value = sample.query;
          field.focus();
        }
      }
    })
  ];

  return {
    refresh: () => morph(root, template()),
    unmount() {
      stop();
      offs.forEach((off) => off());
      if (controller) controller.abort();
      seq += 1;
      if (ragStore.get().status === 'loading') ragStore.set({ status: ragStore.get().result ? 'ready' : 'idle' });
      root.remove();
    }
  };
}
