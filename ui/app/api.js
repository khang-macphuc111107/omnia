// Omnia Studio UI — client for the omnia-studio.exe loopback API (/api/*).
//
// Contract: docs/ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md §4. There is NO fixture
// fallback: when the server is unreachable or answers with an error, callers get
// an ApiError and must render an explicit error/offline state.
//
//   import { api, ApiError, describeError } from '../../api.js';
//   const { sessions } = await api.sessions.list();
//
// Side effects worth knowing (server behaviour, not UI choices):
//   - api.router.decide({ simulate: true }) is a side-effect-free deterministic
//     preview; live decisions reserve tokens and a concurrency slot until a
//     lifecycle operation reconciles them. Call live decisions only on an
//     explicit user action.
//   - Everything except sessions lives in server memory and resets on restart.

import { createStore } from './core/store.js';
import { t } from './core/i18n.js';

export class ApiError extends Error {
  constructor({ status = 0, code = 'unknown', message = '', path = '' } = {}) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.path = path;
  }

  get isNetwork() {
    return this.code === 'network' || this.code === 'timeout';
  }
}

// ---------------------------------------------------------------------------
// Connection state (drives the sidebar indicator and offline banners)
// ---------------------------------------------------------------------------

export const connection = createStore({
  status: 'connecting', // transport reachability: 'connecting' | 'online' | 'offline'
  serviceHealth: 'unknown', // service health: 'unknown' | 'healthy' | 'degraded' | 'unhealthy'
  health: null,         // last /api/health body
  healthCheckedAt: 0,   // timestamp of last /api/health probe
  lastOkAt: 0,
  lastError: null,
  retryAt: 0
});

function noteReachable() {
  const state = connection.get();
  if (state.status !== 'online') {
    const wasOffline = state.status === 'offline';
    connection.set({ status: 'online', lastError: null, retryAt: 0, lastOkAt: Date.now() });
    scheduleHealth(0);
    // Views that poll refresh at once instead of waiting for their next tick.
    if (wasOffline) kickPollers();
  } else if (Date.now() - state.lastOkAt > 5000) {
    connection.set({ lastOkAt: Date.now() });
  }
}

function noteUnreachable(error) {
  const state = connection.get();
  if (state.status !== 'offline') {
    connection.set({ status: 'offline', lastError: error });
    scheduleHealth(2000);
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10000;

function buildUrl(path, query) {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function request(method, path, { body, query, timeout = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const init = {
    method,
    headers: { Accept: 'application/json' },
    signal: controller.signal,
    cache: 'no-store'
  };
  if (method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {}); // the server requires a JSON object, even {}
  }

  let response;
  let text;
  try {
    response = await fetch(buildUrl(path, query), init);
    text = await response.text();
  } catch (error) {
    if (!timedOut && signal && signal.aborted) throw new ApiError({ code: 'aborted', path });
    const apiError = new ApiError({ code: timedOut ? 'timeout' : 'network', path, message: error && error.message });
    noteUnreachable(apiError);
    throw apiError;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  noteReachable();
  if (!response.ok) {
    throw new ApiError({
      status: response.status,
      code: (data && data.error) || `http_${response.status}`,
      message: (data && data.message) || '',
      path
    });
  }
  if (data === null || typeof data !== 'object') {
    throw new ApiError({ status: response.status, code: 'invalid_response', path });
  }
  return data;
}

const get = (path, query, opts) => request('GET', path, { ...opts, query });
const post = (path, body, opts) => request('POST', path, { ...opts, body });

// ---------------------------------------------------------------------------
// Response normalizers (align Rust omnia-studio camelCase/snake_case payloads)
// ---------------------------------------------------------------------------

function normalizeSession(s) {
  if (!s || typeof s !== 'object') return s;
  return {
    ...s,
    modelId: s.modelId ?? s.model_id ?? '',
    createdAt: s.createdAt ?? s.createdAtMs ?? 0,
    updatedAt: s.updatedAt ?? s.updatedAtMs ?? 0
  };
}

function normalizeSessionsPayload(data) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  if (Array.isArray(data.sessions)) out.sessions = data.sessions.map(normalizeSession);
  if (data.session && typeof data.session === 'object') out.session = normalizeSession(data.session);
  return out;
}

function normalizeSteerItem(item) {
  if (!item || typeof item !== 'object') return item;
  return { ...item, createdAt: item.createdAt ?? item.created_at_ms ?? 0 };
}

function normalizeSteerPayload(data) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  if (Array.isArray(data.items)) out.items = data.items.map(normalizeSteerItem);
  if (data.item && typeof data.item === 'object') out.item = normalizeSteerItem(data.item);
  return out;
}

function normalizeTemplatesPayload(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.templates)) return data;
  return {
    ...data,
    templates: data.templates.map((tpl) => {
      if (!tpl || typeof tpl !== 'object') return tpl;
      return {
        ...tpl,
        category: tpl.category === 'Math' ? 'Mathematics' : tpl.category,
        title: tpl.title ?? tpl.label ?? tpl.id ?? '',
        latex: tpl.latex ?? tpl.latex_snippet ?? '',
        symbol: tpl.symbol ?? tpl.unicode_preview ?? '',
        description: tpl.description ?? tpl.unicode_preview ?? ''
      };
    })
  };
}

function normalizeGraphMessage(m) {
  if (!m || typeof m !== 'object') return m;
  const recipients = Array.isArray(m.recipients) ? m.recipients : [];
  return {
    ...m,
    from: m.from ?? m.from_id ?? '',
    to: m.to ?? (recipients.length > 1 ? '@all' : recipients[0] ?? ''),
    text: m.text ?? m.payload ?? '',
    timestampMs: m.timestampMs ?? m.sent_at_ms ?? 0,
    hop: m.hop ?? m.hop_count,
    maxHops: m.maxHops ?? m.max_hops,
    provenance: m.provenance ?? 'EXTRACTED'
  };
}

function normalizeGraphEntity(node) {
  if (!node || typeof node !== 'object') return node;
  return {
    ...node,
    path: node.path ?? node.sourcePath ?? node.source_path ?? '',
    summary: node.summary ?? node.symbolSpan ?? node.symbol_span ?? ''
  };
}

function normalizeGraphEdge(edge) {
  if (!edge || typeof edge !== 'object') return edge;
  return {
    ...edge,
    from: edge.from ?? edge.from_id ?? '',
    to: edge.to ?? edge.to_id ?? '',
    confidenceBps: edge.confidenceBps ?? edge.confidence_bps,
    note: edge.note ?? edge.sourceLocator ?? edge.source_locator ?? ''
  };
}

function normalizeGraphPayload(data) {
  if (!data || typeof data !== 'object') return data;
  const links = Array.isArray(data.links)
    ? data.links.map((link) => ({
        ...link,
        from: link.from ?? link.from_id ?? '',
        to: link.to ?? link.to_id ?? '',
        mode: link.mode ?? (link.bidirectional === false || link.duplex === false ? 'Directed' : 'Duplex')
      }))
    : undefined;
  const nodes = Array.isArray(data.nodes)
    ? data.nodes.map((node) => {
        const id = node.id;
        const incomingCount = node.incomingCount ?? (links ? links.filter((l) => l.to === id).length : 0);
        const outgoingCount = node.outgoingCount ?? (links ? links.filter((l) => l.from === id).length : 0);
        const duplexPeers =
          node.duplexPeers ??
          (links
            ? Array.from(
                new Set(
                  links
                    .filter((l) => l.mode !== 'Directed' && (l.from === id || l.to === id))
                    .map((l) => (l.from === id ? l.to : l.from))
                )
              )
            : []);
        return {
          ...node,
          label: node.label ?? id,
          state: node.state ?? (node.active === false ? 'INACTIVE' : 'ACTIVE'),
          disjointPaths: node.disjointPaths ?? node.owned_paths ?? [],
          excludedPaths: node.excludedPaths ?? node.excluded_paths ?? [],
          lastSeq: node.lastSeq ?? node.last_read_seq,
          incomingCount,
          outgoingCount,
          duplexPeers
        };
      })
    : undefined;
  return {
    ...data,
    ...(nodes ? { nodes } : {}),
    ...(links ? { links } : {}),
    ...(Array.isArray(data.messages) ? { messages: data.messages.map(normalizeGraphMessage) } : {}),
    ...(data.message ? { message: normalizeGraphMessage(data.message) } : {}),
    ...(Array.isArray(data.graphifyNodes) ? { graphifyNodes: data.graphifyNodes.map(normalizeGraphEntity) } : {}),
    ...(Array.isArray(data.graphifyEdges) ? { graphifyEdges: data.graphifyEdges.map(normalizeGraphEdge) } : {}),
    ...(Array.isArray(data.visitedEntities) ? { visitedEntities: data.visitedEntities.map(normalizeGraphEntity) } : {}),
    ...(Array.isArray(data.edges) ? { edges: data.edges.map(normalizeGraphEdge) } : {}),
    ...(Array.isArray(data.quarantinedAmbiguous)
      ? { quarantinedAmbiguous: data.quarantinedAmbiguous.map(normalizeGraphEdge) }
      : {})
  };
}

function normalizeRouterCandidate(c) {
  if (!c || typeof c !== 'object') return c;
  const rawCaps = c.candidate && typeof c.candidate.capabilities === 'object' ? c.candidate.capabilities : null;
  const capabilitiesFlags =
    c.capabilitiesFlags ??
    (rawCaps
      ? {
          streaming: Boolean(rawCaps.supports_streaming),
          vision: Boolean(rawCaps.supports_vision),
          tools: Boolean(rawCaps.supports_tool_calls),
          reasoning: Boolean(rawCaps.supports_reasoning)
        }
      : {});
  const capabilities = Array.isArray(c.capabilities)
    ? c.capabilities
    : Object.entries(capabilitiesFlags)
        .filter(([, enabled]) => Boolean(enabled))
        .map(([name]) => name);
  return {
    ...c,
    id: c.id ?? c.candidateId ?? '',
    region: c.region ?? c.candidate?.region ?? null,
    capabilitiesFlags,
    capabilities
  };
}

function normalizeRouterReceipt(r, reservation = null) {
  if (!r || typeof r !== 'object') return r;
  return {
    ...r,
    decidedAt: r.decidedAt ?? r.decidedAtMs ?? 0,
    selectedRoute: r.selectedRoute ?? r.selectedCandidateId ?? null,
    policyClass: r.policyClass ?? (r.tokenBudget === null ? 'unbounded' : null),
    reservedTokens: r.reservedTokens ?? reservation?.reserved_tokens ?? null,
    promptRedacted: typeof r.promptRedacted === 'boolean' ? r.promptRedacted : true,
    secretsExposed: r.secretsExposed ?? 0
  };
}

function normalizeRouterPayload(data) {
  if (!data || typeof data !== 'object') return data;
  return {
    ...data,
    ...(Array.isArray(data.candidates) ? { candidates: data.candidates.map(normalizeRouterCandidate) } : {}),
    ...(Array.isArray(data.recentReceipts)
      ? { recentReceipts: data.recentReceipts.map((r) => normalizeRouterReceipt(r)) }
      : {}),
    ...(data.receipt ? { receipt: normalizeRouterReceipt(data.receipt, data.reservation) } : {})
  };
}

function normalizeMemoryEntry(e) {
  if (!e || typeof e !== 'object') return e;
  return { ...e, updatedAt: e.updatedAt ?? e.updatedAtMs ?? 0 };
}

function normalizeErasureReceipt(r) {
  if (!r || typeof r !== 'object') return r;
  const fallbackId = r.namespace && r.key ? `${r.namespace}/${r.key}` : r.key ?? '';
  return {
    ...r,
    erasedId: r.erasedId ?? fallbackId,
    erasedAt: r.erasedAt ?? r.erasedAtMs ?? 0
  };
}

function normalizeMemoryPayload(data) {
  if (!data || typeof data !== 'object') return data;
  return {
    ...data,
    ...(Array.isArray(data.entries) ? { entries: data.entries.map(normalizeMemoryEntry) } : {}),
    ...(data.entry ? { entry: normalizeMemoryEntry(data.entry) } : {}),
    ...(Array.isArray(data.erasures) ? { erasures: data.erasures.map(normalizeErasureReceipt) } : {}),
    ...(data.receipt ? { receipt: normalizeErasureReceipt(data.receipt) } : {})
  };
}

function normalizeRagPayload(data) {
  if (!data || typeof data !== 'object') return data;
  return {
    ...data,
    ...(Array.isArray(data.subQueries)
      ? {
          subQueries: data.subQueries.map((q) => ({
            ...q,
            angle: q.angle ?? q.intent ?? '',
            query: q.query ?? q.text ?? ''
          }))
        }
      : {}),
    ...(Array.isArray(data.citedSources)
      ? {
          citedSources: data.citedSources.map((s) => ({
            ...s,
            id: s.id ?? s.source_id ?? '',
            snippet: s.snippet ?? s.excerpt ?? '',
            score: s.score ?? (Number.isFinite(s.relevance_bps) ? s.relevance_bps / 10000 : 0)
          }))
        }
      : {}),
    ...(Array.isArray(data.unusedSources)
      ? {
          unusedSources: data.unusedSources.map((s) => ({
            ...s,
            id: s.id ?? s.source_id ?? '',
            title: s.title ?? s.source_id ?? s.locator ?? '',
            reason: s.reason ?? s.exclusion_reason ?? ''
          }))
        }
      : {})
  };
}

function normalizeCapabilityEntry(cap, fallbackCheckedAt = 0, fallbackSource = '') {
  if (!cap || typeof cap !== 'object') return null;
  const id = String(cap.id ?? cap.name ?? '').trim();
  if (!id) return null;
  const rawStatus = typeof (cap.status ?? cap.readiness) === 'string' ? String(cap.status ?? cap.readiness).trim().toLowerCase() : '';
  const enabled =
    typeof cap.enabled === 'boolean'
      ? cap.enabled
      : typeof cap.ready === 'boolean'
        ? cap.ready
        : typeof cap.available === 'boolean'
          ? cap.available
          : rawStatus === 'ready' || rawStatus === 'enabled' || rawStatus === 'ok' || rawStatus === 'available';
  let status = rawStatus;
  if (!status || status === 'enabled' || status === 'ok' || status === 'available') {
    status = enabled ? 'ready' : 'unavailable';
  } else if (status === 'off' || status === 'false') {
    status = 'disabled';
  }
  const detailParts = [];
  if (typeof cap.detail === 'string' && cap.detail.trim()) detailParts.push(cap.detail.trim());
  else if (typeof cap.reason === 'string' && cap.reason.trim()) detailParts.push(cap.reason.trim());
  else {
    if (cap.backend) detailParts.push(String(cap.backend));
    if (cap.mode) detailParts.push(String(cap.mode));
    if (cap.schema) detailParts.push(String(cap.schema));
    if (cap.invariant) detailParts.push(String(cap.invariant));
    if (Array.isArray(cap.directions) && cap.directions.length) detailParts.push(cap.directions.join('/'));
    if (Number.isFinite(cap.timeoutMs)) detailParts.push(`${cap.timeoutMs}ms`);
    if (cap.erasureReceipts === true) detailParts.push('erasureReceipts');
  }
  return {
    ...cap,
    id,
    name: String(cap.name ?? id),
    enabled,
    status,
    endpoint: typeof cap.endpoint === 'string' ? cap.endpoint : '',
    source: typeof cap.source === 'string' && cap.source ? cap.source : fallbackSource,
    detail: detailParts.join(' · '),
    remediation: typeof cap.remediation === 'string' ? cap.remediation : '',
    checkedAt: Number(cap.checkedAt ?? cap.checkedAtMs ?? cap.updatedAt ?? fallbackCheckedAt ?? 0) || 0
  };
}

function normalizeCapabilitiesPayload(data) {
  if (!data || typeof data !== 'object') return data;
  const checkedAt = Number(data.checkedAt ?? data.checkedAtMs ?? data.updatedAt ?? 0) || 0;
  const source = typeof data.schema === 'string' ? data.schema : 'omnia.capabilities.v1';
  const rawList = Array.isArray(data.capabilities) ? data.capabilities : [];
  return {
    ...data,
    schema: source,
    checkedAt,
    capabilities: rawList.map((entry) => normalizeCapabilityEntry(entry, checkedAt, source)).filter(Boolean)
  };
}

// ---------------------------------------------------------------------------
// Endpoints (shapes in the spec §4)
// ---------------------------------------------------------------------------

export const api = {
  /** → { ok, engine, compiler, crateCount, rustFiles, httpStack, sqliteBackend, pid, workingSetBytes, binaryBytes, skillCount, peerCount } */
  health: (opts) => get('/api/health', null, opts),

  /** → { ok, schema, listener, checkedAt, capabilities:[{ id, name, enabled, status, endpoint, source, detail, remediation, checkedAt }] } */
  capabilities: async (opts) => normalizeCapabilitiesPayload(await get('/api/capabilities', null, opts)),

  chat: {
    /** Abort an active chat/agent run on the server (best-effort cancellation). */
    stop: (body = {}, opts) => post('/api/chat/stop', body, opts)
  },

  sessions: {
    /** Bounded keyset page → { ok, sessions, totalCount, nextCursor, activeLease }. */
    list: async ({ limit, cursor, ...opts } = {}) => {
      const query =
        cursor && typeof cursor === 'object'
          ? { limit, cursorUpdatedAtMs: cursor.updatedAtMs, cursorId: cursor.id }
          : { limit, cursor };
      return normalizeSessionsPayload(await get('/api/sessions', query, opts));
    },
    /** Resolve a saved/deep-linked ID independently of the list page. */
    get: async (id, opts) => normalizeSessionsPayload(await get(`/api/sessions/${encodeURIComponent(id)}`, null, opts)),
    /** body { title?, modelId?, effort? } → list payload + { session } */
    create: async ({ title, modelId, effort } = {}, opts) =>
      normalizeSessionsPayload(await post('/api/sessions/create', { title, modelId, effort }, opts))
  },

  steer: {
    /** → { ok, tokenBudget:null, items:[{id,seq,text,mode,status,createdAt}] } */
    list: async (opts) => normalizeSteerPayload(await get('/api/steer', null, opts)),
    /** mode: undefined (additive) | 'boundary_correction' | 'explicit_stop_or_replace' → { ok, tokenBudget, item, items } */
    enqueue: async ({ text, mode } = {}, opts) =>
      normalizeSteerPayload(await post('/api/steer/enqueue', mode ? { text, mode } : { text }, opts))
  },

  composer: {
    /** → { ok, templates:[{id,category:'Mathematics'|'Physics'|'Chemistry',title,symbol,latex,description,placeholders}] } */
    templates: async (opts) => normalizeTemplatesPayload(await get('/api/composer/templates', null, opts))
  },

  graph: {
    /** → { ok, nodes, links, messages, graphifyNodes, graphifyEdges } */
    get: async (opts) => normalizeGraphPayload(await get('/api/graph', null, opts)),
    /** body { from, to:'@all'|id, text, broadcast } → { ok, message, messages } */
    send: async ({ from, to, text, broadcast = false } = {}, opts) =>
      normalizeGraphPayload(await post('/api/graph/send', { from, to, text, broadcast: Boolean(broadcast) }, opts)),
    /** direction 'Both'|'Forward'|'Reverse', maxDepth 1–8 → { ok, entity, direction, maxDepth, visited, visitedEntities, edges, quarantinedAmbiguous } */
    traverse: async ({ entity, direction = 'Both', maxDepth = 3 } = {}, opts) =>
      normalizeGraphPayload(await get('/api/graph/traverse', { entity, direction, maxDepth }, opts))
  },

  router: {
    /** → { ok, candidates:[…], recentReceipts:[…] } */
    state: async (opts) => normalizeRouterPayload(await get('/api/router/state', null, opts)),
    /**
     * body { taskClass, estimatedTokens, privacyTier, requireStreaming, simulate?, idempotencyKey?, tripCandidate?, resetCandidate? }
     * → { ok, selectedCandidateId|null, status, receipt:{…, simulated, scores:[…]}, candidates }
     * Simulation is deterministic and side-effect free; live decisions reserve
     * quota/concurrency until a lifecycle operation reconciles them.
     */
    decide: async (policy = {}, opts) => {
      const payload =
        policy && typeof policy === 'object' && policy.taskClass && !policy.task_class
          ? { ...policy, task_class: policy.taskClass }
          : policy;
      return normalizeRouterPayload(await post('/api/router/decide', payload, opts));
    },
    /** Cancel/release an in-flight or reserved router decision. */
    cancel: async (body = {}, opts) => normalizeRouterPayload(await post('/api/router/cancel', body, opts))
  },

  memory: {
    /** → { ok, entries:[{id,namespace,key,content,tier,contentSha256,updatedAt,links}], erasures:[…] } */
    list: async (opts) => normalizeMemoryPayload(await get('/api/memory', null, opts)),
    /** → { ok, entry, entries? } */
    upsert: async ({ namespace, key, content = '', tier = 'Durable' } = {}, opts) =>
      normalizeMemoryPayload(await post('/api/memory/upsert', { namespace, key, content, tier }, opts)),
    /** target { id } or { namespace, key } → { ok, receipt } */
    erase: async (target = {}, opts) => normalizeMemoryPayload(await post('/api/memory/erase', target, opts))
  },

  rag: {
    /** → { ok, query, language:'en'|'vi'|'bilingual', uncertaintyScore, uncertaintyScoreBps, shouldRetrieve, triggers, subQueries, citedSources, unusedSources } */
    plan: async ({ query = '' } = {}, opts) => normalizeRagPayload(await post('/api/rag/plan', { query }, opts))
  },

  skills: {
    /** → { ok, query, total, skills:[{name,description,path,category,score}] } */
    search: (q = '', opts) => get('/api/skills', { q }, opts)
  }
};

// ---------------------------------------------------------------------------
// Domain constants and validation shared by views (mirror the server rules)
// ---------------------------------------------------------------------------

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const TASK_CLASSES = ['code_generation', 'architecture_synthesis', 'math_derivation', 'multimodal_vision', 'fast_triage'];
export const PRIVACY_TIERS = ['strict_local_zero_retention', 'enterprise_zdr', 'private_vpc', 'standard_cloud'];
export const STEER_MODES = ['additive', 'boundary_correction', 'explicit_stop_or_replace'];
export const TRAVERSE_DIRECTIONS = ['Both', 'Forward', 'Reverse'];
export const TEMPLATE_CATEGORIES = ['Mathematics', 'Physics', 'Chemistry'];

const MEMORY_SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;

/** Returns null when valid, else an error code: 'empty' | 'too_long' | 'too_deep' | 'bad_chars' | 'dot_dot'. */
export function validateMemoryNamespace(namespace) {
  const value = String(namespace ?? '');
  if (!value) return 'empty';
  if (value.length > 256) return 'too_long';
  if (value.includes('..')) return 'dot_dot';
  if (value.startsWith('/') || value.endsWith('/')) return 'bad_chars';
  const segments = value.split('/');
  if (segments.length > 8) return 'too_deep';
  return segments.every((segment) => MEMORY_SEGMENT.test(segment)) ? null : 'bad_chars';
}

export function validateMemoryKey(key) {
  const value = String(key ?? '');
  if (!value) return 'empty';
  if (value.includes('..')) return 'dot_dot';
  return MEMORY_SEGMENT.test(value) ? null : 'bad_chars';
}

// ---------------------------------------------------------------------------
// Errors → user-facing text
// ---------------------------------------------------------------------------

export function describeError(error) {
  if (!(error instanceof ApiError)) return t('api.unknown', { code: (error && error.message) || '?' });
  const key = `api.${error.code}`;
  const text = t(key, { message: error.message, status: error.status, code: error.code });
  return text === key ? t('api.unknown', { code: error.code }) : text;
}

// ---------------------------------------------------------------------------
// Health monitor and polling
// ---------------------------------------------------------------------------

let healthTimer = null;
let healthEvery = 15000;
let failures = 0;
let monitorStarted = false;

function scheduleHealth(delay) {
  if (!monitorStarted) return;
  clearTimeout(healthTimer);
  healthTimer = setTimeout(checkHealth, delay);
}

export async function checkHealth() {
  clearTimeout(healthTimer);
  const checkedAt = Date.now();
  try {
    const health = await api.health({ timeout: 6000 });
    failures = 0;
    const healthy = Boolean(health && health.ok !== false);
    connection.set({
      status: 'online',
      serviceHealth: healthy ? 'healthy' : 'degraded',
      health,
      healthCheckedAt: checkedAt,
      lastOkAt: healthy ? checkedAt : connection.get().lastOkAt,
      lastError: healthy ? null : new ApiError({ code: health?.error || 'health_degraded', path: '/api/health' }),
      retryAt: 0
    });
    if (monitorStarted) healthTimer = setTimeout(checkHealth, healthEvery);
  } catch (error) {
    failures += 1;
    const delay = Math.min(30000, 2000 * 2 ** Math.min(failures - 1, 4));
    connection.set({
      status: error.isNetwork ? 'offline' : 'online',
      serviceHealth: error.isNetwork ? 'unknown' : 'unhealthy',
      healthCheckedAt: checkedAt,
      lastError: error,
      retryAt: Date.now() + delay
    });
    if (monitorStarted) healthTimer = setTimeout(checkHealth, delay);
  }
}

export function startHealthMonitor({ every = 15000 } = {}) {
  healthEvery = every;
  monitorStarted = true;
  checkHealth();
}

/** Re-check the server now (used by "Thử lại" buttons). */
export function retryConnection() {
  failures = 0;
  return checkHealth();
}

const pollers = new Set();

function kickPollers() {
  for (const poller of Array.from(pollers)) poller.kick();
}

/**
 * Run fn now and then every `every` ms while the page is visible. fn must handle
 * its own errors. Runs never overlap. When the server comes back after being
 * offline, every active poller runs immediately. Returns stop().
 */
export function poll(fn, { every = 10000, immediate = true } = {}) {
  let stopped = false;
  let timer = null;
  let running = false;
  let again = false;
  const run = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    clearTimeout(timer);
    running = true;
    if (!document.hidden) {
      try {
        await fn();
      } catch (error) {
        console.error('[omnia] poll', error);
      }
    }
    running = false;
    if (stopped) return;
    if (again) {
      again = false;
      run();
      return;
    }
    timer = setTimeout(run, every);
  };
  const poller = { kick: run };
  pollers.add(poller);
  if (immediate) run();
  else timer = setTimeout(run, every);
  return () => {
    stopped = true;
    clearTimeout(timer);
    pollers.delete(poller);
  };
}
