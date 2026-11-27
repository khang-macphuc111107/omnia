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
  status: 'connecting', // 'connecting' | 'online' | 'offline'
  health: null,         // last /api/health body
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
// Endpoints (shapes in the spec §4)
// ---------------------------------------------------------------------------

export const api = {
  /** → { ok, engine, compiler, cplusplus, rustFiles, pid, workingSetBytes, binaryBytes, skillCount, peerCount } */
  health: (opts) => get('/api/health', null, opts),

  sessions: {
    /** Bounded keyset page → { ok, sessions, totalCount, nextCursor, activeLease }. */
    list: ({ limit, cursor, ...opts } = {}) => get('/api/sessions', { limit, cursor }, opts),
    /** Resolve a saved/deep-linked ID independently of the list page. */
    get: (id, opts) => get(`/api/sessions/${encodeURIComponent(id)}`, null, opts),
    /** body { title?, modelId?, effort? } → list payload + { session } */
    create: ({ title, modelId, effort } = {}, opts) => post('/api/sessions/create', { title, modelId, effort }, opts)
  },

  steer: {
    /** → { ok, tokenBudget:null, items:[{id,seq,text,mode,status,createdAt}] } */
    list: (opts) => get('/api/steer', null, opts),
    /** mode: undefined (additive) | 'boundary_correction' | 'explicit_stop_or_replace' → { ok, tokenBudget, item, items } */
    enqueue: ({ text, mode } = {}, opts) => post('/api/steer/enqueue', mode ? { text, mode } : { text }, opts)
  },

  composer: {
    /** → { ok, templates:[{id,category:'Mathematics'|'Physics'|'Chemistry',title,symbol,latex,description,placeholders}] } */
    templates: (opts) => get('/api/composer/templates', null, opts)
  },

  graph: {
    /** → { ok, nodes, links, messages, graphifyNodes, graphifyEdges } */
    get: (opts) => get('/api/graph', null, opts),
    /** body { from, to:'@all'|id, text, broadcast } → { ok, message, messages } */
    send: ({ from, to, text, broadcast = false } = {}, opts) => post('/api/graph/send', { from, to, text, broadcast: Boolean(broadcast) }, opts),
    /** direction 'Both'|'Forward'|'Reverse', maxDepth 1–8 → { ok, entity, direction, maxDepth, visited, visitedEntities, edges, quarantinedAmbiguous } */
    traverse: ({ entity, direction = 'Both', maxDepth = 3 } = {}, opts) => get('/api/graph/traverse', { entity, direction, maxDepth }, opts)
  },

  router: {
    /** → { ok, candidates:[…], recentReceipts:[…] } */
    state: (opts) => get('/api/router/state', null, opts),
    /**
     * body { taskClass, estimatedTokens, privacyTier, requireStreaming, simulate?, idempotencyKey?, tripCandidate?, resetCandidate? }
     * → { ok, selectedCandidateId|null, status, receipt:{…, simulated, scores:[…]}, candidates }
     * Simulation is deterministic and side-effect free; live decisions reserve
     * quota/concurrency until a lifecycle operation reconciles them.
     */
    decide: (policy = {}, opts) => post('/api/router/decide', policy, opts)
  },

  memory: {
    /** → { ok, entries:[{id,namespace,key,content,tier,contentSha256,updatedAt,links}], erasures:[…] } */
    list: (opts) => get('/api/memory', null, opts),
    /** → { ok, entry, entries } */
    upsert: ({ namespace, key, content = '', tier = 'Durable' } = {}, opts) => post('/api/memory/upsert', { namespace, key, content, tier }, opts),
    /** target { id } or { namespace, key } → { ok, receipt } */
    erase: (target = {}, opts) => post('/api/memory/erase', target, opts)
  },

  rag: {
    /** → { ok, query, language:'en'|'vi'|'bilingual', uncertaintyScore, uncertaintyScoreBps, shouldRetrieve, triggers, subQueries, citedSources, unusedSources } */
    plan: ({ query = '' } = {}, opts) => post('/api/rag/plan', { query }, opts)
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

async function checkHealth() {
  clearTimeout(healthTimer);
  try {
    const health = await api.health({ timeout: 6000 });
    failures = 0;
    connection.set({ status: 'online', health, lastOkAt: Date.now(), lastError: null, retryAt: 0 });
    healthTimer = setTimeout(checkHealth, healthEvery);
  } catch (error) {
    failures += 1;
    const delay = Math.min(30000, 2000 * 2 ** Math.min(failures - 1, 4));
    connection.set({
      status: error.isNetwork ? 'offline' : 'online',
      lastError: error,
      retryAt: Date.now() + delay
    });
    healthTimer = setTimeout(checkHealth, delay);
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
  checkHealth();
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
