// Omnia Studio UI — Routing view (#/routing).
// Contract: docs/ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md §6.3.
//
// POST /api/router/decide is an explicit control-plane action. Simulation is
// side-effect free; trip/reset and execution decisions reserve tokens and a
// concurrency slot until their lifecycle APIs reconcile them.
// It is called ONLY from three explicit user actions: "Chạy mô phỏng", "Ngắt"
// (trip) and "Khôi phục" (reset). Never on mount, poll or refresh: those only
// read GET /api/router/state.

import { registerView, navigate } from '../../core/router.js';
import { html, raw, morph, on, uid } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t, fmtNumber, fmtPercent, fmtTime } from '../../core/i18n.js';
import { storage } from '../../core/store.js';
import { announce, toast, confirmDialog, copyText, rovingFocus } from '../../core/overlay.js';
import { registerCommands } from '../../core/palette.js';
import { api, describeError, poll, TASK_CLASSES, PRIVACY_TIERS } from '../../api.js';
import './strings.js';
import {
  circuitView,
  summarize,
  privacyKey,
  maxKnownRemaining,
  quotaView,
  shortHash,
  sortReceipts,
  normalizeScores,
  findCandidate,
  flagList,
  splitReasons,
  SCORE_KEYS
} from './table.js';
import {
  POLICY_KEY,
  MIN_TOKENS,
  MAX_TOKENS,
  RANGE_STEP,
  clampTokens,
  sanitizePolicy,
  decideBody,
  decisionView,
  receiptRows,
  receiptJson
} from './simulate.js';

const POLL_MS = 15000;
const SCORE_CLASS = ['s1', 's2', 's3', 's4', 's5'];

/** Palette access to the mounted instance (null while the view is not shown). */
let active = null;
let pendingSimulate = false;

function statusChip(view, label) {
  return html`<span class="${view.variant ? `status status--${view.variant}` : 'status'}">${icon(view.icon)}${label}</span>`;
}

function privacyLabel(tier) {
  const key = privacyKey(tier);
  return key ? t(`routing.privacy.${key}`) : tier || '—';
}

function circuitLabel(circuit) {
  const view = circuitView(circuit);
  return view.key === 'other' ? String(circuit || '—') : t(`routing.circuit.${view.key}`);
}

const num = (value) => (Number.isFinite(value) ? fmtNumber(value) : '—');

function mountRouting(host) {
  const abort = new AbortController();
  const ids = {
    task: uid('routing-task'),
    tokens: uid('routing-tokens'),
    range: uid('routing-range'),
    privacy: uid('routing-privacy'),
    stream: uid('routing-stream'),
    simTitle: uid('routing-sim'),
    provTitle: uid('routing-providers'),
    scoreTitle: uid('routing-scores'),
    rcptTitle: uid('routing-receipts')
  };
  const s = {
    data: null, // { candidates, receipts }
    status: 'loading', // loading | ok | stale | error
    error: null,
    updatedAt: 0,
    refreshing: false,
    selectedId: '',
    policy: sanitizePolicy(storage.get(POLICY_KEY, null)),
    lastDecision: null, // { at, kind: 'sim'|'trip'|'reset', target, decision }
    sim: { status: 'idle', result: null, error: null, at: 0 },
    busy: '' // '' | 'sim' | <candidate id being tripped/reset>
  };

  let unmounted = false;
  let loadSeq = 0;
  const cleanups = [];

  // ---------------------------------------------------------------- data

  async function load({ manual = false } = {}) {
    const seq = ++loadSeq;
    if (manual) {
      s.refreshing = true;
      paint();
    }
    try {
      const data = await api.router.state({ signal: abort.signal });
      if (unmounted || seq !== loadSeq) return;
      s.data = {
        candidates: Array.isArray(data.candidates) ? data.candidates : [],
        receipts: sortReceipts(data.recentReceipts)
      };
      s.status = 'ok';
      s.error = null;
      s.updatedAt = Date.now();
      if (s.selectedId && !s.data.candidates.some((c) => c.id === s.selectedId)) s.selectedId = '';
      if (manual) announce(t('routing.announce.updated', { n: s.data.candidates.length }));
    } catch (error) {
      if (unmounted || seq !== loadSeq || (error && error.code === 'aborted')) return;
      s.error = error;
      s.status = s.data ? 'stale' : 'error';
      if (manual) announce(describeError(error));
    }
    s.refreshing = false;
    paint();
  }

  function savePolicy() {
    storage.set(POLICY_KEY, s.policy);
  }

  /** The only place that calls decide(). Callers have already obtained the user's confirmation. */
  async function decide(kind, target = '') {
    if (s.busy) return;
    const extra = kind === 'sim'
      ? { simulate: true }
      : kind === 'trip' ? { tripCandidate: target } : kind === 'reset' ? { resetCandidate: target } : {};
    s.busy = kind === 'sim' ? 'sim' : target;
    if (kind === 'sim') s.sim = { ...s.sim, status: 'running', error: null };
    paint();
    try {
      const decision = await api.router.decide(decideBody(s.policy, extra), { signal: abort.signal });
      if (unmounted) return;
      s.lastDecision = { at: Date.now(), kind, target, decision };
      if (kind === 'sim') s.sim = { status: 'ok', result: decision, error: null, at: Date.now() };
      const fenced = decision.ok === false;
      const reserved = decision.receipt ? decision.receipt.reservedTokens : null;
      const title =
        kind === 'trip'
          ? t('routing.toast.tripped', { id: target })
          : kind === 'reset'
            ? t('routing.toast.reset', { id: target })
            : fenced
              ? t('routing.toast.fenced')
              : t('routing.toast.routed', { route: decision.selectedCandidateId || '—' });
      const message = fenced && kind === 'sim'
        ? t('routing.toast.fencedText')
        : kind === 'sim' && decision.receipt && decision.receipt.simulated
          ? t('routing.toast.simulated')
          : t('routing.toast.reserved', { n: num(reserved) });
      toast({ variant: fenced && kind === 'sim' ? 'warn' : 'ok', title, message });
      announce(`${title}. ${message}`);
      s.busy = '';
      paint();
      await load();
    } catch (error) {
      if (unmounted || (error && error.code === 'aborted')) return;
      s.busy = '';
      if (kind === 'sim') s.sim = { ...s.sim, status: 'error', error };
      toast({ variant: 'danger', title: t('routing.toast.failed'), message: describeError(error) });
      announce(describeError(error));
      paint();
    }
  }

  // The warning banner beside the button already states the reservation side
  // effect, so a simulation runs directly; trip/reset keep their confirm dialog.
  async function runSimulation() {
    if (s.busy || unmounted) return;
    decide('sim');
  }

  async function circuitAction(op, id) {
    if (s.busy) return;
    const trip = op === 'trip';
    const ok = await confirmDialog({
      title: trip ? t('routing.confirm.tripTitle', { id }) : t('routing.confirm.resetTitle', { id }),
      message: t(trip ? 'routing.confirm.tripText' : 'routing.confirm.resetText', {
        id,
        tokens: fmtNumber(s.policy.estimatedTokens)
      }),
      confirmLabel: trip ? t('routing.action.trip') : t('routing.action.reset'),
      danger: trip
    });
    if (ok && !unmounted) decide(op, id);
  }

  async function copy(text, what) {
    const ok = await copyText(text);
    toast({ variant: ok ? 'info' : 'warn', title: ok ? t('routing.copied', { what }) : t('routing.copyFailed') });
    announce(ok ? t('routing.copied', { what }) : t('routing.copyFailed'));
  }

  // ---------------------------------------------------------------- rendering

  function paint() {
    if (unmounted) return;
    morph(host, view());
  }

  function view() {
    return html`${topbar()}
      <div class="view__body routing-body" data-key="body">
        <section class="pane fill scroll routing-main" aria-label="${t('routing.main.label')}">
          <div class="routing-content">${s.data ? mainContent() : placeholder()}</div>
        </section>
        ${simPanel()}
      </div>`;
  }

  function topbar() {
    return html`<header class="topbar" data-key="topbar">
      <h1 class="topbar__title">${t('nav.routing')}</h1>
      <span class="text-sm muted hide-md routing-sub">${t('routing.subtitle')}</span>
      <span class="grow"></span>
      <span class="text-xs muted hide-sm routing-meta">${t('routing.autoRefresh')}${s.updatedAt ? html` · <span class="num">${t('routing.updatedAt', { time: fmtTime(s.updatedAt, true) })}</span>` : null}</span>
      <button type="button" class="btn btn--ghost btn--icon" data-action="refresh" aria-label="${t('routing.refresh')}" title="${t('routing.refresh')}" aria-disabled="${s.refreshing}" aria-busy="${s.refreshing}">${icon('refresh')}</button>
    </header>`;
  }

  function placeholder() {
    if (s.status === 'error') {
      const offline = s.error && s.error.isNetwork;
      return html`<div class="card empty" role="alert" data-key="error">
        <span class="empty__icon routing-danger">${icon(offline ? 'wifi-off' : 'alert', { size: 'lg' })}</span>
        <p class="empty__title">${t('routing.error.title')}</p>
        <p class="empty__text">${describeError(s.error)} <span class="mono">GET /api/router/state</span><br>${t('routing.error.noFallback')}</p>
        <button type="button" class="btn btn--sm" data-action="refresh">${t('common.retry')}</button>
      </div>`;
    }
    return html`<div class="routing-loading" role="status" aria-live="polite" data-key="loading">
      <div class="routing-tiles">${[1, 2, 3, 4].map(() => html`<div class="card card--pad col"><span class="skeleton routing-skel routing-skel--sm"></span><span class="skeleton routing-skel routing-skel--lg"></span></div>`)}</div>
      <div class="card card--pad col routing-loading__card">
        <span class="skeleton routing-skel routing-skel--xl"></span><span class="skeleton routing-skel routing-skel--md"></span>
        <span class="skeleton routing-skel routing-skel--xl"></span><span class="skeleton routing-skel routing-skel--md"></span>
      </div>
      <span class="sr-only">${t('routing.loading')}</span>
    </div>`;
  }

  function staleBanner() {
    if (s.status !== 'stale') return null;
    return html`<div class="banner banner--warn" data-key="stale" role="status">
      ${icon('alert', { className: 'banner__icon' })}
      <div class="banner__body">
        <span class="banner__title">${t('routing.stale.title')}</span>
        <span>${describeError(s.error)} ${t('routing.stale.text', { time: fmtTime(s.updatedAt, true) })}</span>
      </div>
      <button type="button" class="btn btn--sm" data-action="refresh">${t('common.retry')}</button>
    </div>`;
  }

  function mainContent() {
    const { candidates, receipts } = s.data;
    return html`${staleBanner()}${tiles(candidates)}${providersCard(candidates)}${scoresCard()}${receiptsCard(receipts)}`;
  }

  function tiles(candidates) {
    const sum = summarize(candidates);
    const tile = (key, value, dot) =>
      html`<div class="card card--pad col routing-tile" data-key="tile-${key}"><span class="text-xs muted">${t(`routing.tile.${key}`)}</span><span class="row routing-tile__value">${dot ? html`<span class="dot dot--${dot}" aria-hidden="true"></span>` : null}<span class="num">${fmtNumber(value)}</span></span></div>`;
    return html`<div class="routing-tiles" data-key="tiles" role="group" aria-label="${t('routing.tile.label')}">
      ${tile('providers', sum.total, '')}${tile('active', sum.closed, 'ok')}${tile('retry', sum.halfOpen, 'warn')}${tile('open', sum.open, 'danger')}
    </div>`;
  }

  function quotaCell(candidate, maxKnown) {
    const q = quotaView(candidate, maxKnown);
    switch (q.kind) {
      case 'known':
        if (q.remaining === null) return html`<span class="text-xs muted">—</span>`;
        return html`<div class="col routing-quota">
          <span class="text-xs num">${t('routing.quota.known', { remaining: fmtNumber(q.remaining), reserve: num(q.reserve) })}</span>
          <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="${q.max}" aria-valuenow="${q.remaining}" aria-label="${t('routing.quota.meter', { pct: fmtNumber(q.pct, { maximumFractionDigits: 0 }) })}"><div class="meter__fill" style="width: ${q.pct}%;"></div></div>
        </div>`;
      case 'stale':
        return html`<div class="col routing-quota">
          <span class="status status--warn">${icon('alert')}${t('routing.quota.stale')}</span>
          <span class="text-xs muted num">${q.remaining === null ? t('routing.quota.noValue') : t('routing.quota.unverified', { remaining: fmtNumber(q.remaining) })}</span>
        </div>`;
      case 'contradictory':
        return html`<div class="col routing-quota">
          <span class="status status--danger">${icon('alert-circle')}${t('routing.quota.contradictory')}</span>
          <span class="text-xs muted num">${q.remaining === null ? t('routing.quota.noValue') : t('routing.quota.unverified', { remaining: fmtNumber(q.remaining) })}</span>
        </div>`;
      default:
        return html`<div class="col routing-quota">
          <span class="status status--warn">${icon('info')}${t('routing.quota.unknown')}</span>
          <span class="text-xs muted">${t('routing.quota.neverZero')}</span>
          <div class="meter meter--unknown" aria-hidden="true"></div>
        </div>`;
    }
  }

  function providersCard(candidates) {
    const maxKnown = maxKnownRemaining(candidates);
    const selected = findCandidate(candidates, s.selectedId);
    return html`<div class="card" data-key="providers" aria-labelledby="${ids.provTitle}" role="region">
      <div class="card__header"><h2 class="card__title" id="${ids.provTitle}">${t('routing.providers.title')}</h2><span class="text-xs muted">${t('routing.providers.hint')}</span></div>
      ${candidates.length === 0
        ? html`<div class="empty"><p class="empty__title">${t('routing.providers.emptyTitle')}</p><p class="empty__text">${t('routing.providers.emptyText')}</p></div>`
        : html`<div class="table-wrap">
            <table class="table routing-table">
              <caption class="sr-only">${t('routing.providers.caption')}</caption>
              <thead><tr>
                <th scope="col">${t('routing.col.provider')}</th><th scope="col">${t('routing.col.privacy')}</th><th scope="col">${t('routing.col.circuit')}</th>
                <th scope="col">${t('routing.col.quota')}</th><th scope="col" class="num">${t('routing.col.latency')} · ${t('routing.col.errors')}</th>
                <th scope="col"><span class="sr-only">${t('routing.col.actions')}</span></th>
              </tr></thead>
              <tbody>${candidates.map((candidate) => providerRow(candidate, maxKnown))}</tbody>
            </table>
          </div>`}
      ${selected ? detail(selected) : null}
    </div>`;
  }

  function providerRow(candidate, maxKnown) {
    const view = circuitView(candidate.circuit);
    const isOpen = candidate.circuit === 'Open';
    const isSelected = candidate.id === s.selectedId;
    const busy = Boolean(s.busy);
    const op = isOpen ? 'reset' : 'trip';
    const label = t(isOpen ? 'routing.action.reset' : 'routing.action.trip');
    return html`<tr data-key="c-${candidate.id}" aria-selected="${isSelected}">
      <td>
        <div class="col routing-id">
          <button type="button" class="routing-rowbtn mono strong" data-action="select" data-id="${candidate.id}" aria-pressed="${isSelected}">${candidate.id}</button>
          <span class="text-xs muted mono">${candidate.providerId} / ${candidate.modelId}</span>
        </div>
      </td>
      <td><span class="chip">${privacyLabel(candidate.privacyTier)}</span></td>
      <td>${statusChip(view, circuitLabel(candidate.circuit))} <span class="mono text-xs muted">${candidate.circuit}</span></td>
      <td class="routing-quota-cell">${quotaCell(candidate, maxKnown)}</td>
      <td class="num">
        <div>${num(candidate.ewmaMs)} · ${num(candidate.p95Ms)} ms</div>
        <div class="text-xs muted">${Number.isFinite(candidate.errorRate) ? fmtPercent(candidate.errorRate, 1) : '—'}</div>
      </td>
      <td class="routing-actions"><button type="button" class="${isOpen ? 'btn btn--sm' : 'btn btn--sm btn--danger'}" data-action="circuit" data-op="${op}" data-id="${candidate.id}" aria-disabled="${busy}" aria-busy="${s.busy === candidate.id}" aria-label="${label} · ${candidate.id}" title="${t('routing.action.hint')}">${label}</button></td>
    </tr>`;
  }

  function detail(candidate) {
    const score = s.lastDecision && s.lastDecision.decision.receipt && Array.isArray(s.lastDecision.decision.receipt.scores)
      ? s.lastDecision.decision.receipt.scores.find((row) => row.candidateId === candidate.id)
      : null;
    const flags = flagList(candidate.capabilitiesFlags);
    const view = circuitView(candidate.circuit);
    return html`<div class="card__body routing-detail" data-key="detail">
      <div class="row between wrap">
        <h3 class="strong mono">${candidate.id}</h3>
        <div class="row wrap">${statusChip(view, circuitLabel(candidate.circuit))}<span class="chip">${privacyLabel(candidate.privacyTier)}</span></div>
      </div>
      <div class="routing-detail__grid">
        <dl class="kv">
          <dt>${t('routing.detail.provider')}</dt><dd class="mono">${candidate.providerId}</dd>
          <dt>${t('routing.detail.model')}</dt><dd class="mono">${candidate.modelId}</dd>
          <dt>${t('routing.detail.privacy')}</dt><dd><span class="mono">${candidate.privacyTier}</span></dd>
          <dt>${t('routing.detail.region')}</dt><dd class="mono">${candidate.region || '—'}</dd>
          <dt>${t('routing.detail.quotaState')}</dt><dd class="mono">${candidate.quotaState}</dd>
          <dt>${t('routing.detail.remaining')}</dt><dd class="num">${candidate.remainingTokens === null || candidate.remainingTokens === undefined ? t('routing.quota.noValue') : t('routing.tokens', { n: fmtNumber(candidate.remainingTokens) })}</dd>
          <dt>${t('routing.detail.reserve')}</dt><dd class="num">${t('routing.tokens', { n: num(candidate.reserveTokens) })}</dd>
        </dl>
        <div class="col routing-detail__side">
          <div class="col routing-fieldset"><span class="section-title">${t('routing.detail.capabilities')}</span>
            <div class="row wrap">${(candidate.capabilities || []).length ? candidate.capabilities.map((cap) => html`<span class="chip chip--mono">${cap}</span>`) : html`<span class="text-sm muted">${t('common.none')}</span>`}</div>
          </div>
          <div class="col routing-fieldset"><span class="section-title">${t('routing.detail.flags')}</span>
            <div class="row wrap">${flags.length ? flags.map(([name, enabled]) => html`<span class="chip chip--mono${enabled ? '' : ' routing-flag--off'}">${icon(enabled ? 'check' : 'x', { size: 'sm' })}${name}<span class="sr-only"> (${enabled ? t('common.yes') : t('common.no')})</span></span>`) : html`<span class="text-sm muted">${t('common.none')}</span>`}</div>
          </div>
          <div class="col routing-fieldset"><span class="section-title">${t('routing.detail.lastScore')}</span>
            ${score
              ? score.eligible
                ? html`<span class="text-sm num">${t('routing.score.total', { total: fmtNumber(score.totalScore) })} <span class="muted">· ${t('routing.score.raw', { raw: fmtNumber(score.totalScoreBps / 100, { maximumFractionDigits: 1 }) })}</span></span>`
                : html`<span class="text-sm routing-reject">${t('routing.score.rejected')}: <span class="mono">${score.rejectedReason || '—'}</span></span>`
              : html`<span class="text-sm muted">${t('routing.detail.noScore')}</span>`}
          </div>
        </div>
      </div>
    </div>`;
  }

  function scoresCard() {
    const last = s.lastDecision;
    const receipt = last && last.decision && last.decision.receipt;
    const scores = receipt && Array.isArray(receipt.scores) ? receipt.scores : [];
    const { rows } = normalizeScores(scores);
    const selectedId = last && last.decision ? last.decision.selectedCandidateId : null;
    return html`<div class="card" data-key="scores" role="region" aria-labelledby="${ids.scoreTitle}">
      <div class="card__header">
        <h2 class="card__title" id="${ids.scoreTitle}">${t('routing.scores.title')}</h2>
        ${receipt ? html`<span class="row"><span class="text-xs muted">${t(`routing.scores.kind.${last.kind}`)} · ${fmtTime(last.at, true)}</span><span class="chip chip--mono">${receipt.receiptId || '—'}</span></span>` : null}
      </div>
      ${rows.length === 0
        ? html`<div class="empty"><p class="empty__title">${t('routing.scores.emptyTitle')}</p><p class="empty__text">${t('routing.scores.emptyText')}</p></div>`
        : html`<div class="card__body col routing-scores">
            <div class="legend">${SCORE_KEYS.map((key, index) => html`<span class="legend__item"><span class="swatch ${SCORE_CLASS[index]}"></span>${t(`routing.scores.${key}`)}</span>`)}</div>
            ${rows.map((row, rowIndex) => {
              const aria = SCORE_KEYS.map((key, index) => `${t(`routing.scores.${key}`)} ${row.parts[index]}`).join(', ');
              const extras = [];
              if (row.preference) extras.push(`${t('routing.scores.preference')} ${row.preference}`);
              if (row.priority) extras.push(`${t('routing.scores.priority')} ${row.priority}`);
              return html`<div class="col routing-score enter" style="--i: ${Math.min(rowIndex, 12)}" data-key="s-${row.candidateId}">
                <div class="row between text-sm">
                  <span class="row"><span class="mono">${row.candidateId}</span>${row.candidateId === selectedId ? html`<span class="status status--accent">${icon('check')}${t('routing.scores.selected')}</span>` : null}</span>
                  <span class="num strong">${row.eligible ? t('routing.score.total', { total: fmtNumber(row.total) }) : t('routing.score.rejected')}${row.eligible && row.bps > 10000 ? html` <span class="muted text-xs">· ${t('routing.score.raw', { raw: fmtNumber(row.rawTotal, { maximumFractionDigits: 1 }) })}</span>` : null}</span>
                </div>
                <div class="stackbar" role="img" aria-label="${row.eligible ? aria : t('routing.score.rejected')}">${row.segments.map((seg, index) => html`<span class="${SCORE_CLASS[index]}" style="width: ${seg.pct}%;"></span>`)}</div>
                ${extras.length ? html`<span class="text-xs muted num">${extras.join(' · ')}</span>` : null}
                ${!row.eligible
                  ? html`<span class="text-xs routing-reject">${t('routing.score.rejected')}: ${splitReasons(row.rejectedReason).map((reason) => html`<span class="mono">${reason}</span> `)}</span>`
                  : null}
              </div>`;
            })}
          </div>`}
    </div>`;
  }

  function receiptsCard(receipts) {
    return html`<div class="card" data-key="receipts" role="region" aria-labelledby="${ids.rcptTitle}">
      <div class="card__header"><h2 class="card__title" id="${ids.rcptTitle}">${t('routing.receipts.title')}</h2><span class="text-xs muted">${t('routing.receipts.hint')}</span></div>
      ${receipts.length === 0
        ? html`<div class="empty"><p class="empty__title">${t('routing.receipts.emptyTitle')}</p><p class="empty__text">${t('routing.receipts.emptyText')}</p></div>`
        : html`<div class="table-wrap">
            <table class="table">
              <caption class="sr-only">${t('routing.receipts.caption')}</caption>
              <thead><tr>
                <th scope="col">${t('routing.col.receipt')}</th><th scope="col">${t('routing.col.time')}</th><th scope="col">${t('routing.col.route')}</th>
                <th scope="col">${t('routing.col.policy')}</th><th scope="col" class="num">${t('routing.col.reserved')}</th><th scope="col">${t('routing.col.hash')}</th>
              </tr></thead>
              <tbody>${receipts.map(
                (r, index) => html`<tr class="enter" style="--i: ${Math.min(index, 12)}" data-key="r-${r.receiptId}">
                  <td class="mono">${r.receiptId}</td>
                  <td class="num muted">${fmtTime(r.decidedAt, true)}</td>
                  <td class="mono">${r.selectedRoute || '—'}</td>
                  <td class="mono text-xs">${r.policyClass}</td>
                  <td class="num">${num(r.reservedTokens)}</td>
                  <td><span class="row routing-hash"><span class="mono text-xs muted" title="${r.policyHash}">${shortHash(r.policyHash)}</span><button type="button" class="btn btn--ghost btn--icon btn--sm" data-action="copy" data-text="${r.policyHash}" data-what="${t('routing.copy.hash')}" aria-label="${t('routing.copy.hashFor', { id: r.receiptId })}" title="${t('common.copy')}">${icon('copy', { size: 'sm' })}</button></span></td>
                </tr>`
              )}</tbody>
            </table>
          </div>`}
    </div>`;
  }

  // ---- simulation panel

  function segment(group, label, items, value) {
    return html`<div class="field">
      <span class="field__label" id="${group}">${label}</span>
      <div class="seg routing-privseg" role="radiogroup" aria-labelledby="${group}">
        ${items.map(
          (item) => html`<button type="button" class="seg__item" data-key="p-${item.value}" role="radio" data-action="privacy" data-value="${item.value}" aria-checked="${value === item.value}" tabindex="${value === item.value ? '0' : '-1'}">${item.label}</button>`
        )}
      </div>
    </div>`;
  }

  function simPanel() {
    const p = s.policy;
    const running = s.busy === 'sim';
    return html`<aside class="panel scroll routing-sim" data-key="sim" aria-label="${t('routing.sim.title')}">
      <div class="panel__header"><h2 class="panel__title" id="${ids.simTitle}">${t('routing.sim.title')}</h2></div>
      <form class="panel__section" data-form="sim" novalidate aria-labelledby="${ids.simTitle}">
        <div class="field">
          <label class="field__label" for="${ids.task}">${t('routing.sim.task')}</label>
          <select class="select" id="${ids.task}" data-field="task">${TASK_CLASSES.map((cls) => html`<option value="${cls}"${cls === p.taskClass ? raw(' selected') : null}>${t(`routing.task.${cls}`)} · ${cls}</option>`)}</select>
        </div>
        <div class="field">
          <label class="field__label" for="${ids.tokens}">${t('routing.sim.tokens')}</label>
          <div class="routing-tokens">
            <input class="input num" id="${ids.tokens}" data-field="tokens" type="number" min="${MIN_TOKENS}" max="${MAX_TOKENS}" step="1" value="${p.estimatedTokens}" inputmode="numeric">
            <input class="range" id="${ids.range}" data-field="range" type="range" min="${MIN_TOKENS}" max="${MAX_TOKENS}" step="${RANGE_STEP}" value="${p.estimatedTokens}" aria-label="${t('routing.sim.tokensRange')}">
          </div>
          <span class="field__hint">${t('routing.sim.tokensHint', { min: fmtNumber(MIN_TOKENS), max: fmtNumber(MAX_TOKENS) })}</span>
        </div>
        ${segment(ids.privacy, t('routing.sim.privacy'), PRIVACY_TIERS.map((tier) => ({ value: tier, label: privacyLabel(tier) })), p.privacyTier)}
        <label class="switch" for="${ids.stream}"><input type="checkbox" id="${ids.stream}" data-field="stream"${p.requireStreaming ? raw(' checked') : null}>${t('routing.sim.streaming')}</label>
        <div class="banner banner--warn">
          ${icon('alert', { className: 'banner__icon' })}
          <div class="banner__body"><span>${t('routing.sim.warning')}</span></div>
        </div>
        <button type="submit" class="btn btn--primary btn--block" aria-disabled="${Boolean(s.busy)}" aria-busy="${running}">${icon('play')}${running ? t('routing.sim.running') : t('routing.sim.run')}</button>
      </form>
      ${simResult()}
    </aside>`;
  }

  function simResult() {
    const sim = s.sim;
    if (sim.status === 'error' && !sim.result) {
      return html`<div class="panel__section" data-key="sim-result"><div class="banner banner--danger" role="alert">${icon('stop', { className: 'banner__icon' })}<div class="banner__body"><span class="banner__title">${t('routing.toast.failed')}</span><span>${describeError(sim.error)}</span></div></div></div>`;
    }
    if (!sim.result) {
      return html`<div class="panel__section" data-key="sim-result"><p class="text-sm muted">${t('routing.sim.noResult')}</p></div>`;
    }
    const decision = sim.result;
    const view = decisionView(decision);
    const json = receiptJson(decision);
    return html`<div class="panel__section routing-result enter" data-key="sim-result" aria-live="polite">
      <div class="row between wrap">${statusChip(view, view.label)}<span class="text-xs muted num">${fmtTime(sim.at, true)}</span></div>
      <div class="col routing-route">
        <span class="text-xs muted">${t('routing.sim.selectedRoute')}</span>
        ${decision.selectedCandidateId
          ? html`<span class="mono strong">${decision.selectedCandidateId}</span>`
          : html`<span class="routing-reject">${t('routing.sim.noRoute')}</span>`}
      </div>
      <dl class="kv">
        ${receiptRows(decision.receipt).map((row) => {
          let value;
          if (row.value === null) value = '—';
          else if (row.bool) value = row.key === 'promptRedacted' ? (row.value ? t('routing.sim.redacted') : t('common.no')) : row.value ? t('common.yes') : t('common.no');
          else if (row.key === 'reservedTokens') value = t('routing.tokens', { n: fmtNumber(row.value) });
          else if (row.key === 'estimatedCostMicrounits') value = `${fmtNumber(row.value)} µ`;
          else if (row.number) value = fmtNumber(row.value);
          else value = String(row.value);
          return html`<dt>${t(`routing.rk.${row.key}`)}</dt><dd class="${row.mono ? 'mono' : ''}${row.number ? ' num' : ''}${row.key === 'policyHash' ? ' text-xs' : ''}">${value}${row.copy && row.value !== null ? html` <button type="button" class="btn btn--ghost btn--icon btn--sm" data-action="copy" data-text="${row.value}" data-what="${t('routing.copy.hash')}" aria-label="${t('routing.copy.hash')}" title="${t('common.copy')}">${icon('copy', { size: 'sm' })}</button>` : null}</dd>`;
        })}
      </dl>
      <details class="disclosure routing-json" data-preserve="open">
        <summary>${icon('chevron-right', { size: 'sm', className: 'chev' })}${t('routing.sim.json')}</summary>
        <div class="disclosure__body">
          <pre class="mono text-xs routing-json__pre">${json}</pre>
          <button type="button" class="btn btn--sm" data-action="copy-json">${icon('copy', { size: 'sm' })}${t('routing.sim.copyJson')}</button>
        </div>
      </details>
    </div>`;
  }

  // ---------------------------------------------------------------- events

  cleanups.push(
    on(host, 'click', '[data-action]', (event, el) => {
      const action = el.getAttribute('data-action');
      const id = el.getAttribute('data-id');
      switch (action) {
        case 'refresh':
          if (!s.refreshing) load({ manual: true });
          break;
        case 'select':
          s.selectedId = s.selectedId === id ? '' : id;
          paint();
          break;
        case 'circuit':
          circuitAction(el.getAttribute('data-op'), id);
          break;
        case 'privacy':
          s.policy = sanitizePolicy({ ...s.policy, privacyTier: el.getAttribute('data-value') });
          savePolicy();
          paint();
          break;
        case 'copy':
          copy(el.getAttribute('data-text') || '', el.getAttribute('data-what') || '');
          break;
        case 'copy-json':
          if (s.sim.result) copy(receiptJson(s.sim.result), t('routing.copy.json'));
          break;
        default:
      }
    })
  );

  function setTokens(value) {
    s.policy = { ...s.policy, estimatedTokens: clampTokens(value, s.policy.estimatedTokens) };
    savePolicy();
  }

  cleanups.push(
    on(host, 'input', '[data-field]', (event, el) => {
      const field = el.getAttribute('data-field');
      if (field === 'tokens') {
        if (el.value !== '' && Number.isFinite(Number(el.value))) {
          setTokens(el.value);
          paint(); // the range follows; the focused number input keeps what the user typed
        }
      } else if (field === 'range') {
        setTokens(el.value);
        const number = host.querySelector(`#${ids.tokens}`);
        if (number) number.value = String(s.policy.estimatedTokens);
      }
    })
  );

  cleanups.push(
    on(host, 'change', '[data-field]', (event, el) => {
      const field = el.getAttribute('data-field');
      if (field === 'task') s.policy = sanitizePolicy({ ...s.policy, taskClass: el.value });
      else if (field === 'stream') s.policy = sanitizePolicy({ ...s.policy, requireStreaming: el.checked });
      else if (field === 'tokens') {
        setTokens(el.value);
        el.value = String(s.policy.estimatedTokens);
      } else return;
      savePolicy();
      paint();
    })
  );

  cleanups.push(
    on(host, 'submit', '[data-form="sim"]', (event) => {
      event.preventDefault();
      runSimulation();
    })
  );

  cleanups.push(rovingFocus(host, '.routing-privseg .seg__item', { onActivate: (el) => el.click() }));

  // ---------------------------------------------------------------- lifecycle

  paint();
  const stopPoll = poll(() => load(), { every: POLL_MS });
  const instance = {
    refresh() {
      if (!s.refreshing) load({ manual: true });
    },
    simulate() {
      runSimulation();
    }
  };
  active = instance;
  if (pendingSimulate) {
    pendingSimulate = false;
    setTimeout(() => {
      if (!unmounted) runSimulation();
    }, 0);
  }

  return {
    update() {
      paint();
    },
    unmount() {
      unmounted = true;
      if (active === instance) active = null;
      abort.abort();
      stopPoll();
      for (const stop of cleanups.splice(0)) stop();
    }
  };
}

registerView({
  id: 'routing',
  order: 3,
  shortcut: '3',
  icon: 'route',
  placement: 'main',
  label: () => t('nav.routing'),
  title: () => t('nav.routing'),
  mount: mountRouting
});

registerCommands(() => [
  {
    id: 'routing.simulate',
    group: t('routing.cmd.group'),
    title: t('routing.cmd.simulate'),
    keywords: 'routing simulate decide dinh tuyen chay mo phong',
    icon: 'play',
    run: () => {
      if (active) active.simulate();
      else {
        pendingSimulate = true;
        navigate('#/routing');
      }
    }
  },
  {
    id: 'routing.refresh',
    group: t('routing.cmd.group'),
    title: t('routing.cmd.refresh'),
    keywords: 'routing router refresh state dinh tuyen lam moi trang thai',
    icon: 'refresh',
    when: () => active !== null,
    run: () => active && active.refresh()
  }
]);
