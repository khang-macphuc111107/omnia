// Omnia Studio UI — Agents view: peer mesh (#/agents) and Graphify code graph (#/agents/code).
// Contract: docs/ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md §6.2. Real data only (GET /api/graph
// polled every 10 s, GET /api/graph/traverse, POST /api/graph/send); no fixtures.

import { registerView, navigate, currentRoute } from '../../core/router.js';
import { html, raw, morph, on, uid } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t, fmtNumber, fmtTime } from '../../core/i18n.js';
import { announce, toast, rovingFocus } from '../../core/overlay.js';
import { registerCommands } from '../../core/palette.js';
import { api, describeError, poll } from '../../api.js';
import './strings.js';
import {
  MAX_LOG,
  nodeCode,
  effectiveSelection,
  maxSeq,
  nextPulse,
  pulseEdges,
  logMessages,
  describeRoute,
  provenanceView,
  stateView,
  countLinks,
  meshEpoch,
  defaultPair,
  normalizeGraph
} from './mesh.js';
import {
  MIN_DEPTH,
  MAX_DEPTH,
  DIRECTIONS,
  normalizeDepth,
  normalizeDirection,
  groupEntities,
  defaultRoot,
  readTraverse,
  confidencePercent
} from './code-graph.js';
import { createMeshCanvas } from './graph-canvas.js';

const POLL_MS = 10000;
const TAB_MESH = 'mesh';
const TAB_CODE = 'code';

const tabOf = (route) => (route && route.params && route.params[0] === 'code' ? TAB_CODE : TAB_MESH);
const isCodeRoute = () => {
  const route = currentRoute();
  return route.view === 'agents' && route.params[0] === 'code';
};
const isMeshRoute = () => {
  const route = currentRoute();
  return route.view === 'agents' && route.params[0] !== 'code';
};

/** Palette access to the mounted instance (null while the view is not shown). */
let active = null;

function chipStatus(view, label) {
  return html`<span class="${view.variant ? `status status--${view.variant}` : 'status'}">${icon(view.icon)}${label}</span>`;
}

function roleLabel(role) {
  const key = `agents.role.${role}`;
  const text = t(key);
  return text === key ? role || '—' : text;
}

function mountAgents(host, initialRoute) {
  const abort = new AbortController();
  const ids = {
    from: uid('agents-from'),
    to: uid('agents-to'),
    text: uid('agents-text'),
    root: uid('agents-root'),
    depth: uid('agents-depth'),
    dir: uid('agents-dir'),
    filter: uid('agents-filter'),
    peerTitle: uid('agents-peer'),
    logTitle: uid('agents-log')
  };
  const s = {
    tab: tabOf(initialRoute),
    graph: null,
    status: 'loading', // loading | ok | stale | error
    error: null,
    updatedAt: 0,
    refreshing: false,
    selectedId: null,
    mode: 'graph',
    send: { from: '', to: '', text: '', broadcast: false, busy: false, error: '' },
    code: { filter: '', entityId: '', root: '', direction: 'Both', depth: 3, status: 'idle', result: null, error: null }
  };

  let unmounted = false;
  let canvasEl = null;
  let canvasCtl = null;
  let lastSeq = null;
  let pendingPulse = null;
  let loadSeq = 0;
  let travSeq = 0;
  const cleanups = [];

  // ---------------------------------------------------------------- data

  function ingest(data) {
    const graph = normalizeGraph(data);
    const newest = maxSeq(graph.messages);
    const pulse = nextPulse(lastSeq, graph.messages);
    if (pulse && pulse.edges.length > 0) pendingPulse = pulse;
    lastSeq = lastSeq === null ? newest : Math.max(lastSeq, newest);
    s.graph = graph;
    s.status = 'ok';
    s.error = null;
    s.updatedAt = Date.now();
    const code = s.code;
    if (!graph.graphifyNodes.some((node) => node.id === code.root)) {
      code.root = defaultRoot(graph.graphifyNodes, graph.graphifyEdges);
    }
    if (code.entityId && !graph.graphifyNodes.some((node) => node.id === code.entityId)) code.entityId = '';
    const pair = defaultPair(graph.nodes, s.selectedId, s.send);
    s.send.from = pair.from;
    s.send.to = s.send.broadcast ? '@all' : pair.to;
  }

  async function load({ manual = false } = {}) {
    const seq = ++loadSeq;
    if (manual) {
      s.refreshing = true;
      paint();
    }
    try {
      const data = await api.graph.get({ signal: abort.signal });
      if (unmounted || seq !== loadSeq) return;
      ingest(data);
      if (manual) announce(t('agents.announce.updated', { peers: s.graph.nodes.length, messages: s.graph.messages.length }));
    } catch (error) {
      if (unmounted || seq !== loadSeq || (error && error.code === 'aborted')) return;
      s.error = error;
      s.status = s.graph ? 'stale' : 'error';
      if (manual) announce(describeError(error));
    }
    s.refreshing = false;
    paint();
  }

  async function traverse() {
    const code = s.code;
    if (!code.root || code.status === 'loading') return;
    const params = { entity: code.root, direction: code.direction, maxDepth: code.depth };
    const seq = ++travSeq;
    code.status = 'loading';
    code.error = null;
    code.entityId = code.root;
    paint();
    try {
      const data = await api.graph.traverse(params, { signal: abort.signal });
      if (unmounted || seq !== travSeq) return;
      code.result = { ...data, params };
      code.status = 'ok';
      const read = readTraverse(code.result);
      announce(t('agents.code.announce', { entities: read.entityCount, edges: read.edgeCount }));
    } catch (error) {
      if (unmounted || seq !== travSeq || (error && error.code === 'aborted')) return;
      code.status = 'error';
      code.error = error;
      announce(describeError(error));
    }
    paint();
  }

  async function submitSend() {
    const send = s.send;
    if (send.busy || !s.graph) return;
    const text = send.text.trim();
    send.error = '';
    if (!text) {
      send.error = t('api.empty_message');
      paint();
      return;
    }
    send.busy = true;
    paint();
    try {
      const to = send.broadcast ? '@all' : send.to;
      const response = await api.graph.send({ from: send.from, to, text, broadcast: send.broadcast }, { signal: abort.signal });
      if (unmounted) return;
      const message = response && response.message;
      if (message) {
        lastSeq = Math.max(lastSeq || 0, Number(message.seq) || 0);
        const edges = pulseEdges(message);
        if (edges.length > 0) pendingPulse = { seq: Number(message.seq), edges };
      }
      send.text = '';
      send.busy = false;
      const textarea = host.querySelector(`#${ids.text}`);
      if (textarea) textarea.value = '';
      toast({ variant: 'ok', title: t('agents.send.sent', { seq: message ? message.seq : '?' }) });
      announce(t('agents.send.sent', { seq: message ? message.seq : '?' }));
      paint();
      load();
    } catch (error) {
      if (unmounted || (error && error.code === 'aborted')) return;
      send.busy = false;
      send.error = describeError(error);
      announce(send.error);
      paint();
    }
  }

  // ---------------------------------------------------------------- rendering

  function paint() {
    if (unmounted) return;
    morph(host, view());
    syncCanvas();
  }

  function selectNode(id) {
    s.selectedId = id;
    const pair = defaultPair(s.graph ? s.graph.nodes : [], id, { from: s.send.from, to: s.send.to });
    s.send.from = pair.from;
    s.send.to = s.send.broadcast ? '@all' : pair.to;
    paint();
  }

  function syncCanvas() {
    const graphMode = s.tab === TAB_MESH && s.mode === 'graph' && s.graph && s.graph.nodes.length > 0;
    const el = graphMode ? host.querySelector('canvas[data-agents-canvas]') : null;
    if (el !== canvasEl) {
      if (canvasCtl) canvasCtl.destroy();
      canvasCtl = null;
      canvasEl = el;
      if (el) canvasCtl = createMeshCanvas(el, { onSelect: selectNode });
    }
    if (canvasCtl) {
      const selected = effectiveSelection(s.graph.nodes, s.selectedId);
      canvasCtl.setModel({ nodes: s.graph.nodes, links: s.graph.links, selectedId: selected ? selected.id : null });
      canvasCtl.setLabel(
        t('agents.canvas.label', {
          peers: s.graph.nodes.length,
          links: s.graph.links.length,
          name: selected ? selected.label || selected.id : '—'
        })
      );
      if (pendingPulse) canvasCtl.pulse(pendingPulse.edges);
    }
    pendingPulse = null;
  }

  function tabLink(tab, href, label, count) {
    const current = s.tab === tab;
    return html`<a class="tab" data-key="tab-${tab}" href="${href}" aria-current="${current ? 'page' : 'false'}" tabindex="${current ? '0' : '-1'}">${label}${count === null ? null : html`<span class="count">${fmtNumber(count)}</span>`}</a>`;
  }

  function topbar() {
    const graph = s.graph;
    return html`<header class="topbar" data-key="topbar">
      <h1 class="topbar__title">${t('nav.agents')}</h1>
      <nav class="tabs agents-tabs" aria-label="${t('agents.tabsLabel')}">
        ${tabLink(TAB_MESH, '#/agents', t('agents.tab.mesh'), graph ? graph.nodes.length : null)}
        ${tabLink(TAB_CODE, '#/agents/code', t('agents.tab.code'), graph ? graph.graphifyNodes.length : null)}
      </nav>
      <span class="grow"></span>
      <span class="text-xs muted hide-sm agents-meta">${t('agents.autoRefresh')}${s.updatedAt ? html` · <span class="num">${t('agents.updatedAt', { time: fmtTime(s.updatedAt, true) })}</span>` : null}</span>
      <button type="button" class="btn btn--ghost btn--icon" data-action="refresh" aria-label="${t('agents.refresh')}" title="${t('agents.refresh')}" aria-disabled="${s.refreshing}" aria-busy="${s.refreshing}">${icon('refresh')}</button>
    </header>`;
  }

  function placeholder() {
    if (s.status === 'error') {
      const offline = s.error && s.error.isNetwork;
      return html`<div class="empty grow" role="alert">
        <span class="empty__icon agents-danger">${icon(offline ? 'wifi-off' : 'alert', { size: 'lg' })}</span>
        <p class="empty__title">${t('agents.error.title')}</p>
        <p class="empty__text">${describeError(s.error)} <span class="mono">GET /api/graph</span><br>${t('agents.error.noFallback')}</p>
        <button type="button" class="btn btn--sm" data-action="refresh">${t('common.retry')}</button>
      </div>`;
    }
    return html`<div class="agents-loading grow" role="status" aria-live="polite">
      <div class="card card--pad col agents-loading__card">
        <span class="skeleton agents-skel agents-skel--lg"></span>
        <span class="skeleton agents-skel agents-skel--md"></span>
        <span class="skeleton agents-skel agents-skel--lg"></span>
        <span class="skeleton agents-skel agents-skel--sm"></span>
      </div>
      <span class="sr-only">${t('agents.loading')}</span>
    </div>`;
  }

  function staleBanner() {
    if (s.status !== 'stale') return null;
    return html`<div class="banner banner--warn agents-stale" data-key="stale" role="status">
      ${icon('alert', { className: 'banner__icon' })}
      <div class="banner__body">
        <span class="banner__title">${t('agents.stale.title')}</span>
        <span>${describeError(s.error)} ${t('agents.stale.text', { time: fmtTime(s.updatedAt, true) })}</span>
      </div>
      <button type="button" class="btn btn--sm" data-action="refresh">${t('common.retry')}</button>
    </div>`;
  }

  function view() {
    const body = s.tab === TAB_CODE ? codeBody() : meshBody();
    return html`${topbar()}${body}`;
  }

  // ---- mesh tab

  function meshBody() {
    const graph = s.graph;
    if (!graph) return html`<div class="view__body" data-key="body-none">${placeholder()}</div>`;
    const selected = effectiveSelection(graph.nodes, s.selectedId);
    return html`<div class="view__body agents-body" data-key="body-mesh">
      <section class="pane fill agents-main" aria-label="${t('agents.mesh.label')}">
        ${staleBanner()}
        ${meshToolbar(graph)}
        ${graph.nodes.length === 0
          ? html`<div class="empty grow" data-key="mesh-empty">
              <span class="empty__icon">${icon('agents', { size: 'lg' })}</span>
              <p class="empty__title">${t('agents.mesh.emptyTitle')}</p>
              <p class="empty__text">${t('agents.mesh.emptyText')}</p>
            </div>`
          : s.mode === 'graph'
            ? meshStage(graph, selected)
            : meshList(graph, selected)}
      </section>
      ${inspector(graph, selected)}
    </div>`;
  }

  function meshToolbar(graph) {
    const links = countLinks(graph.links);
    const epoch = meshEpoch(graph.nodes);
    const modeBtn = (mode, label) =>
      html`<button type="button" class="seg__item" data-key="mode-${mode}" data-action="mode" data-mode="${mode}" aria-pressed="${s.mode === mode}" tabindex="${s.mode === mode ? '0' : '-1'}">${label}</button>`;
    return html`<div class="agents-toolbar" data-key="toolbar">
      <div class="seg agents-modeseg" role="group" aria-label="${t('agents.mode.label')}">
        ${modeBtn('graph', t('agents.mode.graph'))}${modeBtn('list', t('agents.mode.list'))}
      </div>
      <div class="row gap-2 wrap text-xs subtle">
        <span class="chip num">${t('agents.chip.peers', { count: graph.nodes.length, n: fmtNumber(graph.nodes.length) })}</span>
        <span class="chip num">${t('agents.chip.duplex', { count: links.duplex, n: fmtNumber(links.duplex) })}</span>
        ${links.directed > 0 ? html`<span class="chip num">${t('agents.chip.directed', { count: links.directed, n: fmtNumber(links.directed) })}</span>` : null}
        ${epoch === null ? null : html`<span class="chip chip--mono">epoch ${epoch}</span>`}
      </div>
    </div>`;
  }

  function meshStage(graph, selected) {
    const directed = countLinks(graph.links).directed > 0;
    return html`<div class="graph-stage agents-stage" data-key="stage">
        <canvas class="agents-canvas" data-agents-canvas data-morph-skip role="img" aria-label="${t('agents.canvas.label', { peers: graph.nodes.length, links: graph.links.length, name: selected ? selected.label : '—' })}"></canvas>
        <div class="legend agents-legend">
          <span class="legend__item"><span class="swatch agents-swatch--line"></span>${t('agents.legend.duplex')}</span>
          ${directed ? html`<span class="legend__item"><span class="swatch agents-swatch--arrow"></span>${t('agents.legend.directed')}</span>` : null}
          <span class="legend__item"><span class="swatch agents-swatch--hot"></span>${t('agents.legend.selected')}</span>
          <span class="legend__item"><span class="swatch agents-swatch--dot"></span>${t('agents.legend.pulse')}</span>
        </div>
      </div>
      <div class="agents-strip" data-key="strip" role="group" aria-label="${t('agents.strip.label')}">
        ${graph.nodes.map((node) => {
          const isOn = selected && selected.id === node.id;
          const state = stateView(node.state);
          return html`<button type="button" class="btn btn--sm agents-strip__btn" data-key="n-${node.id}" data-action="select-node" data-id="${node.id}" aria-pressed="${Boolean(isOn)}" tabindex="${isOn ? '0' : '-1'}"><span class="dot ${state.variant ? `dot--${state.variant}` : ''}" aria-hidden="true"></span>${node.label || node.id}<span class="sr-only"> (${state.label})</span></button>`;
        })}
      </div>`;
  }

  function meshList(graph, selected) {
    return html`<div class="agents-list" data-key="list">
      <div class="card table-wrap">
        <table class="table">
          <caption class="sr-only">${t('agents.list.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">${t('agents.col.id')}</th>
              <th scope="col">${t('agents.col.label')}</th>
              <th scope="col">${t('agents.col.role')}</th>
              <th scope="col">${t('agents.col.state')}</th>
              <th scope="col" class="num">${t('agents.col.inOut')}</th>
              <th scope="col">${t('agents.col.duplex')}</th>
              <th scope="col" class="num">${t('agents.col.lastSeq')}</th>
            </tr>
          </thead>
          <tbody>
            ${graph.nodes.map((node) => {
              const isOn = Boolean(selected && selected.id === node.id);
              return html`<tr data-key="r-${node.id}" aria-selected="${isOn}">
                <td><button type="button" class="agents-rowbtn mono strong" data-action="select-node" data-id="${node.id}" aria-pressed="${isOn}">${node.id}</button></td>
                <td>${node.label || '—'}</td>
                <td>${roleLabel(node.role)}</td>
                <td>${chipStatus(stateView(node.state), stateView(node.state).label)}</td>
                <td class="num">${fmtNumber(node.incomingCount)} · ${fmtNumber(node.outgoingCount)}</td>
                <td class="agents-peers">${(node.duplexPeers || []).length ? (node.duplexPeers || []).map((peer) => html`<span class="chip chip--mono">${peer}</span> `) : html`<span class="muted">—</span>`}</td>
                <td class="num mono">${node.lastSeq === undefined ? '—' : `#${node.lastSeq}`}</td>
              </tr>`;
            })}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  function inspector(graph, selected) {
    return html`<aside class="panel scroll agents-inspector" data-key="inspector" aria-label="${t('agents.inspector.label')}">
      ${selected ? peerSection(selected) : html`<div class="panel__section"><p class="text-sm muted">${t('agents.inspector.none')}</p></div>`}
      ${sendForm(graph)}
      ${logSection(graph)}
    </aside>`;
  }

  function chipList(items, { asButtons = false } = {}) {
    if (!items || items.length === 0) return html`<span class="text-sm muted">${t('common.none')}</span>`;
    return html`<div class="row wrap">${items.map((item) =>
      asButtons
        ? html`<button type="button" class="chip chip--mono agents-chipbtn" data-action="select-node" data-id="${item}">${item}</button>`
        : html`<span class="chip chip--mono">${item}</span>`
    )}</div>`;
  }

  function peerSection(node) {
    const state = stateView(node.state);
    return html`<section class="panel__section" data-key="peer" aria-labelledby="${ids.peerTitle}">
      <div class="row between">
        <div class="row">
          <span class="avatar avatar--accent agents-avatar" aria-hidden="true">${nodeCode(node)}</span>
          <div class="col agents-peer-name">
            <h2 class="strong" id="${ids.peerTitle}">${node.label || node.id}</h2>
            <span class="text-xs muted mono">${node.id}</span>
          </div>
        </div>
        ${chipStatus(state, state.label)}
      </div>
      <dl class="kv">
        <dt>${t('agents.peer.role')}</dt><dd>${roleLabel(node.role)}</dd>
        <dt>${t('agents.peer.epoch')}</dt><dd class="num">${node.epoch ?? '—'} · ${node.maxHops ?? '—'}</dd>
        <dt>${t('agents.peer.inOut')}</dt><dd class="num">${fmtNumber(node.incomingCount)} · ${fmtNumber(node.outgoingCount)}</dd>
        <dt>${t('agents.peer.lastSeq')}</dt><dd class="num mono">${node.lastSeq === undefined ? '—' : `#${node.lastSeq}`}</dd>
      </dl>
      <div class="col agents-fieldset"><span class="section-title">${t('agents.peer.duplex')}</span>${chipList(node.duplexPeers, { asButtons: true })}</div>
      <div class="col agents-fieldset"><span class="section-title">${t('agents.peer.paths')}</span>${chipList(node.disjointPaths)}</div>
      <div class="col agents-fieldset"><span class="section-title">${t('agents.peer.excluded')}</span>${chipList(node.excludedPaths)}</div>
    </section>`;
  }

  function sendForm(graph) {
    const send = s.send;
    const nodeOptions = (value) => graph.nodes.map((node) => html`<option value="${node.id}"${node.id === value ? raw(' selected') : null}>${node.label ? `${node.label} · ${node.id}` : node.id}</option>`);
    return html`<form class="panel__section" data-key="send" data-form="send" novalidate aria-label="${t('agents.send.title')}">
      <h2 class="strong">${t('agents.send.title')}</h2>
      <div class="agents-pair">
        <div class="field">
          <label class="field__label" for="${ids.from}">${t('agents.send.from')}</label>
          <select class="select" id="${ids.from}" data-field="from">${nodeOptions(send.from)}</select>
        </div>
        <span class="agents-pair__arrow">${icon('arrow-right')}</span>
        <div class="field">
          <label class="field__label" for="${ids.to}">${t('agents.send.to')}</label>
          <select class="select" id="${ids.to}" data-field="to"${send.broadcast ? raw(' disabled') : null}>
            ${nodeOptions(send.broadcast ? '' : send.to)}
            <option value="@all"${send.broadcast || send.to === '@all' ? raw(' selected') : null}>${t('agents.send.all')}</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label class="field__label" for="${ids.text}">${t('agents.send.text')}</label>
        <textarea class="textarea" id="${ids.text}" data-field="text" rows="3" placeholder="${t('agents.send.placeholder')}" aria-invalid="${Boolean(send.error)}">${send.text}</textarea>
      </div>
      <label class="check"><input type="checkbox" data-field="broadcast"${send.broadcast ? raw(' checked') : null}>${t('agents.send.broadcast')}</label>
      ${send.error ? html`<p class="field__error" role="alert">${icon('alert-circle', { size: 'sm' })}${send.error}</p>` : null}
      <div class="row between">
        <span class="text-xs muted">${t('agents.send.hint')}</span>
        <button type="submit" class="btn btn--primary btn--sm" aria-disabled="${send.busy}" aria-busy="${send.busy}">${icon('send', { size: 'sm' })}${t('common.send')}</button>
      </div>
    </form>`;
  }

  function logSection(graph) {
    const rows = logMessages(graph.messages, MAX_LOG);
    return html`<section class="panel__section agents-logsec" data-key="log" aria-labelledby="${ids.logTitle}">
      <div class="row between">
        <h2 class="strong" id="${ids.logTitle}">${t('agents.log.title')}</h2>
        <span class="count">${graph.messages.length > rows.length ? t('agents.log.capped', { shown: rows.length, total: graph.messages.length }) : fmtNumber(rows.length)}</span>
      </div>
      ${rows.length === 0
        ? html`<p class="text-sm muted">${t('agents.log.empty')}</p>`
        : html`<ol class="agents-log">${rows.map((message, index) => {
            const prov = provenanceView(message.provenance);
            return html`<li class="agents-msg enter" style="--i: ${Math.min(index, 12)}" data-key="m-${message.seq}">
              <div class="row between text-xs">
                <span class="mono agents-msg__route"><span class="muted">#${message.seq}</span> ${message.from} → ${describeRoute(message)}</span>
                <span class="muted num">${fmtTime(message.timestampMs, true)}</span>
              </div>
              <p class="text-sm agents-msg__text">${message.text}</p>
              <div class="row wrap">
                ${chipStatus(prov, prov.label)}
                <span class="chip chip--mono num">hop ${message.hop ?? '—'}/${message.maxHops ?? '—'}</span>
                ${message.conversationId ? html`<span class="chip chip--mono truncate" title="${message.conversationId}">${message.conversationId}</span>` : null}
              </div>
            </li>`;
          })}</ol>`}
    </section>`;
  }

  // ---- code tab

  function codeBody() {
    const graph = s.graph;
    if (!graph) return html`<div class="view__body" data-key="body-none">${placeholder()}</div>`;
    const code = s.code;
    const groups = groupEntities(graph.graphifyNodes, code.filter);
    const rootNodes = [...graph.graphifyNodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const busy = code.status === 'loading';
    const entity = graph.graphifyNodes.find((node) => node.id === (code.entityId || code.root)) || null;
    return html`<div class="view__body agents-body agents-body--code" data-key="body-code">
      <aside class="pane agents-entities" aria-label="${t('agents.entities.label')}">
        <div class="agents-entities__search">
          <div class="input-group">
            ${icon('search', { size: 'sm' })}
            <input class="input" id="${ids.filter}" type="search" data-field="filter" value="${code.filter}" placeholder="${t('agents.entities.filter')}" aria-label="${t('agents.entities.filter')}" autocomplete="off" spellcheck="false">
          </div>
          <span class="text-xs muted num agents-entities__count">${t('agents.entities.count', { shown: fmtNumber(groups.reduce((n, g) => n + g.count, 0)), total: fmtNumber(graph.graphifyNodes.length) })}</span>
        </div>
        <div class="agents-entities__list scroll">
          ${graph.graphifyNodes.length === 0
            ? html`<p class="text-sm muted agents-pad">${t('agents.entities.none')}</p>`
            : groups.length === 0
              ? html`<div class="empty agents-entities__empty">
                  <p class="empty__text">${t('agents.entities.noMatch', { q: code.filter })}</p>
                  <button type="button" class="btn btn--sm" data-action="clear-filter">${t('common.clear')}</button>
                </div>`
              : groups.map(
                  (group) => html`<section class="agents-group" data-key="g-${group.kind}" aria-label="${group.kind}">
                    <div class="row between agents-group__head"><h3 class="section-title mono">${group.kind}</h3><span class="count">${fmtNumber(group.count)}</span></div>
                    ${group.items.map((node) => {
                      const isOn = node.id === (code.entityId || code.root);
                      return html`<button type="button" class="menu-item agents-entity" data-key="e-${node.id}" data-action="pick-entity" data-id="${node.id}" aria-pressed="${isOn}">
                        <span class="mono text-sm truncate">${node.id}</span>
                        <span class="text-xs muted truncate">${node.path || node.label || ''}</span>
                      </button>`;
                    })}
                  </section>`
                )}
        </div>
      </aside>
      <section class="pane fill agents-results" aria-label="${t('agents.results.label')}" aria-busy="${busy}">
        ${staleBanner()}
        <form class="agents-traverse" data-form="traverse" novalidate aria-label="${t('agents.traverse.title')}">
          <div class="field agents-traverse__root">
            <label class="field__label" for="${ids.root}">${t('agents.traverse.root')}</label>
            <select class="select" id="${ids.root}" data-field="root">${rootNodes.map((node) => html`<option value="${node.id}"${node.id === code.root ? raw(' selected') : null}>${node.id}</option>`)}</select>
          </div>
          <div class="field">
            <span class="field__label" id="${ids.dir}">${t('agents.traverse.direction')}</span>
            <div class="seg agents-dirseg" role="radiogroup" aria-labelledby="${ids.dir}">
              ${DIRECTIONS.map((dir) => html`<button type="button" class="seg__item" data-key="d-${dir}" role="radio" data-action="direction" data-value="${dir}" aria-checked="${code.direction === dir}" tabindex="${code.direction === dir ? '0' : '-1'}">${t(`agents.dir.${dir}`)}</button>`)}
            </div>
          </div>
          <div class="field agents-traverse__depth">
            <label class="field__label" for="${ids.depth}">${t('agents.traverse.depth')}</label>
            <input class="input num" id="${ids.depth}" data-field="depth" type="number" min="${MIN_DEPTH}" max="${MAX_DEPTH}" step="1" value="${code.depth}" inputmode="numeric">
          </div>
          <button type="submit" class="btn btn--primary" aria-disabled="${busy || !code.root}" aria-busy="${busy}">${icon('play')}${t('agents.traverse.run')}</button>
        </form>
        <div class="agents-results__body scroll${busy && code.result ? ' is-busy' : ''}" data-key="results">${codeResults(graph, entity)}</div>
      </section>
    </div>`;
  }

  function entityCard(entity) {
    if (!entity) return null;
    return html`<div class="card agents-entity-card enter" data-key="entity-card">
      <div class="card__header"><h2 class="card__title">${t('agents.entity.title')}</h2><span class="chip">${entity.kind || '—'}</span></div>
      <div class="card__body">
        <dl class="kv">
          <dt>${t('agents.entity.id')}</dt><dd class="mono">${entity.id}</dd>
          <dt>${t('agents.entity.label')}</dt><dd>${entity.label || '—'}</dd>
          <dt>${t('agents.entity.path')}</dt><dd class="mono text-xs">${entity.path || '—'}</dd>
          <dt>${t('agents.entity.summary')}</dt><dd>${entity.summary || '—'}</dd>
        </dl>
      </div>
    </div>`;
  }

  function codeResults(graph, entity) {
    const code = s.code;
    if (code.status === 'loading' && !code.result) {
      return html`<div class="card card--pad col agents-loading__card" role="status">
        <span class="skeleton agents-skel agents-skel--lg"></span><span class="skeleton agents-skel agents-skel--md"></span><span class="skeleton agents-skel agents-skel--lg"></span>
        <span class="sr-only">${t('agents.loading')}</span>
      </div>`;
    }
    if (code.status === 'error' && !code.result) {
      return html`${entityCard(entity)}<div class="card empty" role="alert" data-key="trav-error">
        <span class="empty__icon agents-danger">${icon(code.error && code.error.isNetwork ? 'wifi-off' : 'alert', { size: 'lg' })}</span>
        <p class="empty__title">${t('agents.traverse.errorTitle')}</p>
        <p class="empty__text">${describeError(code.error)} <span class="mono">GET /api/graph/traverse</span></p>
        <button type="button" class="btn btn--sm" data-action="traverse">${t('common.retry')}</button>
      </div>`;
    }
    if (!code.result) {
      return html`${entityCard(entity)}<div class="empty" data-key="trav-idle">
        <span class="empty__icon">${icon('graph', { size: 'lg' })}</span>
        <p class="empty__title">${t('agents.traverse.idleTitle')}</p>
        <p class="empty__text">${t('agents.traverse.idleText')}</p>
      </div>`;
    }
    const read = readTraverse(code.result);
    const params = code.result.params;
    const rootId = params.entity;
    return html`
      ${code.status === 'error'
        ? html`<div class="banner banner--warn" data-key="trav-stale" role="alert">${icon('alert', { className: 'banner__icon' })}<div class="banner__body"><span class="banner__title">${t('agents.traverse.errorTitle')}</span><span>${describeError(code.error)}</span></div><button type="button" class="btn btn--sm" data-action="traverse">${t('common.retry')}</button></div>`
        : null}
      <div class="row wrap agents-summary enter" data-key="summary">
        <span class="strong num">${t('agents.results.summary', { entities: fmtNumber(read.entityCount), edges: fmtNumber(read.edgeCount) })}</span>
        <span class="muted text-sm">${t('agents.results.from', { root: rootId, direction: t(`agents.dir.${normalizeDirection(params.direction)}`).toLowerCase(), depth: params.maxDepth })}</span>
      </div>
      ${entityCard(entity)}
      ${read.empty
        ? html`<div class="banner banner--info" data-key="trav-none">${icon('info', { className: 'banner__icon' })}<div class="banner__body"><span class="banner__title">${t('agents.results.noneTitle')}</span><span>${t('agents.results.noneText', { root: rootId })}</span></div></div>`
        : html`
          <div class="col agents-fieldset" data-key="visited">
            <h3 class="section-title">${t('agents.results.visited')}</h3>
            <div class="row wrap">${read.entities.map((node) => html`<button type="button" class="chip chip--mono agents-chipbtn${node.id === rootId ? ' chip--accent' : ''}" data-action="reroot" data-id="${node.id}" title="${t('agents.results.reroot', { id: node.id })}">${node.id}</button>`)}</div>
          </div>
          <div class="card table-wrap" data-key="edges">
            <table class="table">
              <caption class="sr-only">${t('agents.results.edges')}</caption>
              <thead><tr>
                <th scope="col">${t('agents.col.from')}</th><th scope="col">${t('agents.col.to')}</th><th scope="col">${t('agents.col.relation')}</th>
                <th scope="col">${t('agents.col.provenance')}</th><th scope="col" class="num">${t('agents.col.depth')}</th><th scope="col">${t('agents.col.note')}</th>
              </tr></thead>
              <tbody>${read.edges.length === 0
                ? html`<tr><td colspan="6" class="muted">${t('agents.results.noEdges')}</td></tr>`
                : read.edges.map((edge, index) => {
                    const prov = provenanceView(edge.provenance);
                    return html`<tr class="enter" style="--i: ${Math.min(index, 12)}" data-key="x-${index}-${edge.from}-${edge.to}-${edge.relation}">
                      <td class="mono">${edge.from}</td><td class="mono">${edge.to}</td><td class="subtle">${edge.relation}</td>
                      <td>${chipStatus(prov, prov.label)}</td><td class="num">${edge.depth ?? '—'}</td><td class="text-xs muted agents-note">${edge.note || '—'}</td>
                    </tr>`;
                  })}</tbody>
            </table>
          </div>`}
      ${read.quarantined.length > 0
        ? html`<div class="banner banner--warn" data-key="quarantine" role="note">
            ${icon('alert', { className: 'banner__icon' })}
            <div class="banner__body">
              <span class="banner__title">${t('agents.results.quarantine', { count: read.quarantined.length, n: fmtNumber(read.quarantined.length) })}</span>
              ${read.quarantined.map((edge) => {
                const percent = confidencePercent(edge.confidenceBps);
                return html`<span><span class="mono">${edge.from} → ${edge.to}</span> — ${edge.note || edge.relation}${percent === null ? null : html` <span class="muted num">(${edge.relation} · ${t('agents.results.confidence', { p: fmtNumber(percent, { maximumFractionDigits: 0 }) })})</span>`}</span>`;
              })}
            </div>
          </div>`
        : null}`;
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
        case 'mode':
          s.mode = el.getAttribute('data-mode') === 'list' ? 'list' : 'graph';
          paint();
          break;
        case 'select-node':
          selectNode(id);
          break;
        case 'pick-entity':
          s.code.entityId = id;
          s.code.root = id;
          paint();
          break;
        case 'reroot':
          s.code.root = id;
          traverse();
          break;
        case 'direction':
          s.code.direction = normalizeDirection(el.getAttribute('data-value'));
          paint();
          break;
        case 'clear-filter':
          s.code.filter = '';
          paint();
          break;
        case 'traverse':
          traverse();
          break;
        default:
      }
    })
  );

  cleanups.push(
    on(host, 'input', '[data-field]', (event, el) => {
      const field = el.getAttribute('data-field');
      if (field === 'filter') {
        s.code.filter = el.value;
        paint();
      } else if (field === 'text') {
        s.send.text = el.value;
        if (s.send.error) {
          s.send.error = '';
          paint();
        }
      } else if (field === 'depth') {
        s.code.depth = normalizeDepth(el.value, s.code.depth);
      }
    })
  );

  cleanups.push(
    on(host, 'change', '[data-field]', (event, el) => {
      const field = el.getAttribute('data-field');
      if (field === 'from') s.send.from = el.value;
      else if (field === 'to') s.send.to = el.value;
      else if (field === 'broadcast') {
        s.send.broadcast = el.checked;
        if (el.checked) s.send.to = '@all';
        else s.send.to = defaultPair(s.graph ? s.graph.nodes : [], s.send.from, { from: s.send.from }).to;
      } else if (field === 'root') {
        s.code.root = el.value;
        s.code.entityId = el.value;
      } else if (field === 'depth') {
        s.code.depth = normalizeDepth(el.value, s.code.depth);
        el.value = String(s.code.depth);
        return;
      }
      paint();
    })
  );

  cleanups.push(
    on(host, 'submit', '[data-form]', (event, form) => {
      event.preventDefault();
      if (form.getAttribute('data-form') === 'send') submitSend();
      else traverse();
    })
  );

  cleanups.push(
    on(host, 'keydown', 'textarea[data-field="text"]', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
        submitSend();
      }
    })
  );

  cleanups.push(
    rovingFocus(host, '.agents-tabs .tab', {
      onActivate: (el) => navigate(el.getAttribute('href'))
    }),
    rovingFocus(host, '.agents-modeseg .seg__item', { onActivate: (el) => el.click() }),
    rovingFocus(host, '.agents-dirseg .seg__item', { onActivate: (el) => el.click() }),
    rovingFocus(host, '.agents-strip__btn')
  );

  // ---------------------------------------------------------------- lifecycle

  paint();
  const stopPoll = poll(() => load(), { every: POLL_MS });
  const instance = {
    refresh() {
      if (!s.refreshing) load({ manual: true });
    }
  };
  active = instance;

  return {
    update(route) {
      s.tab = tabOf(route);
      paint();
    },
    unmount() {
      unmounted = true;
      if (active === instance) active = null;
      abort.abort();
      stopPoll();
      if (canvasCtl) canvasCtl.destroy();
      canvasCtl = null;
      canvasEl = null;
      for (const stop of cleanups.splice(0)) stop();
    }
  };
}

registerView({
  id: 'agents',
  order: 2,
  shortcut: '2',
  icon: 'agents',
  placement: 'main',
  label: () => t('nav.agents'),
  title: (route) => (tabOf(route) === TAB_CODE ? `${t('nav.agents')} · ${t('agents.tab.code')}` : t('nav.agents')),
  mount: mountAgents
});

registerCommands(() => [
  {
    id: 'agents.refresh',
    group: t('agents.cmd.group'),
    title: t('agents.cmd.refresh'),
    keywords: 'agents peer graph refresh tac tu lam moi',
    icon: 'refresh',
    when: () => active !== null,
    run: () => active && active.refresh()
  },
  {
    id: 'agents.open-mesh',
    group: t('agents.cmd.group'),
    title: t('agents.cmd.openMesh'),
    keywords: 'agents peer mesh mang peer tac tu',
    icon: 'agents',
    when: () => !isMeshRoute(),
    run: () => navigate('#/agents')
  },
  {
    id: 'agents.open-code',
    group: t('agents.cmd.group'),
    title: t('agents.cmd.openCode'),
    keywords: 'agents graphify code graph do thi ma',
    icon: 'graph',
    when: () => !isCodeRoute(),
    run: () => navigate('#/agents/code')
  }
]);

