import type {
  AgentRunMode,
  BtwThread,
  DualScopeModelConfig,
  EffortLevel,
  HealthSnapshot,
  ModelConfigEntry,
  RouterCandidate,
  SessionRecord,
  WorkspaceEntry,
} from '@/types';

export interface ApiError {
  status: number;
  code: string;
  message: string;
}

export class StudioApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl = '') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private url(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  async json<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.url(path), {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw { status: res.status, code: 'invalid_json', message: text.slice(0, 200) } as ApiError;
    }
    if (!res.ok) {
      const p = parsed as Record<string, unknown>;
      throw {
        status: res.status,
        code: String(p.error || p.code || `http_${res.status}`),
        message: String(p.message || res.statusText || 'Request failed'),
      } as ApiError;
    }
    return parsed as T;
  }

  async safeJson<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
    try {
      const data = await this.json<T>(path, init);
      return { ok: true, data };
    } catch (e) {
      const err = e as Partial<ApiError>;
      return {
        ok: false,
        error: {
          status: err.status ?? 0,
          code: err.code ?? 'network_unreachable',
          message: err.message ?? (e instanceof Error ? e.message : 'Network error'),
        },
      };
    }
  }

  getHealth() {
    return this.safeJson<HealthSnapshot & Record<string, unknown>>('/api/health');
  }

  getOverview() {
    return this.safeJson<Record<string, unknown>>('/api/overview');
  }

  listSessions() {
    return this.safeJson<{ sessions?: SessionRecord[]; items?: SessionRecord[] }>('/api/sessions');
  }

  createSession(title: string, workspace?: string) {
    return this.safeJson<{ session?: SessionRecord }>('/api/sessions/create', {
      method: 'POST',
      body: JSON.stringify({ title, workspace }),
    });
  }

  renameSession(sessionId: string, title: string) {
    return this.safeJson('/api/sessions/rename', {
      method: 'POST',
      body: JSON.stringify({ sessionId, session_id: sessionId, title }),
    });
  }

  forkSession(sessionId: string, turnIdx?: number) {
    return this.safeJson<{ session?: SessionRecord }>('/api/sessions/fork', {
      method: 'POST',
      body: JSON.stringify({ sessionId, session_id: sessionId, turn_idx: turnIdx }),
    });
  }

  rewindSession(sessionId: string, turnIdx: number) {
    return this.safeJson('/api/sessions/rewind', {
      method: 'POST',
      body: JSON.stringify({ sessionId, session_id: sessionId, turn: turnIdx, turn_idx: turnIdx }),
    });
  }

  deleteSession(sessionId: string) {
    return this.safeJson('/api/sessions/delete', {
      method: 'POST',
      body: JSON.stringify({ sessionId, session_id: sessionId }),
    });
  }

  getSessionMessages(sessionId: string) {
    return this.safeJson<{ messages?: Array<Record<string, unknown>> }>(
      `/api/sessions/messages?sessionId=${encodeURIComponent(sessionId)}`,
    );
  }

  getModels() {
    return this.safeJson<{ models?: ModelConfigEntry[]; config?: DualScopeModelConfig }>('/api/models');
  }

  getModelsConfig() {
    return this.safeJson<
      {
        config?: DualScopeModelConfig;
        roles?: Array<{ scope?: string; role?: string; providerId?: string; modelId?: string; effort?: string }>;
        providers?: Array<{ providerId?: string; models?: Array<{ id?: string; name?: string; contextWindow?: number }> }>;
      } & Record<string, unknown>
    >('/api/models/config');
  }

  async saveModelsConfig(config: DualScopeModelConfig) {
    const inferProvider = (model: string): string => {
      if (model.includes('/')) return model.split('/')[0];
      const lower = model.toLowerCase();
      if (lower.includes('claude')) return 'htmustc-claude';
      if (lower.includes('gemini')) return 'htmustc-gemini';
      return 'htmustc-codex';
    };
    const [mainRes, subRes] = await Promise.all([
      this.safeJson('/api/models/config', {
        method: 'POST',
        body: JSON.stringify({
          scope: 'main',
          providerId: inferProvider(config.mainModel),
          modelId: config.mainModel,
          effort: config.mainEffort,
        }),
      }),
      this.safeJson('/api/models/config', {
        method: 'POST',
        body: JSON.stringify({
          scope: 'subagent',
          providerId: inferProvider(config.subagentModel),
          modelId: config.subagentModel,
          effort: config.subagentEffort,
        }),
      }),
    ]);
    return mainRes.ok ? subRes : mainRes;
  }

  stopChat(sessionId: string) {
    return this.safeJson('/api/chat/stop', {
      method: 'POST',
      body: JSON.stringify({ sessionId, session_id: sessionId }),
    });
  }

  steerChat(sessionId: string, prompt: string, mode: 'steer' | 'queue' = 'steer') {
    const path = mode === 'steer' ? '/api/chat/steer' : '/api/chat/queue';
    return this.safeJson(path, {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        session_id: sessionId,
        prompt,
        mode: 'additive_intake',
        tokenBudget: null,
        token_budget: null,
      }),
    });
  }

  uploadAttachment(payload: {
    sessionId: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    placement: 'inline' | 'tray';
    bytesBase64?: string;
    encryptedUnresolved?: boolean;
  }) {
    return this.safeJson<{ id?: string; deduplicated?: boolean; attachment?: Record<string, unknown> }>(
      '/api/attachments/upload',
      {
        method: 'POST',
        body: JSON.stringify({
          ...payload,
          filename: payload.name,
          dataBase64: payload.bytesBase64,
        }),
      },
    );
  }

  async streamChatTurn(
    payload: {
      session_id: string;
      prompt: string;
      model: string;
      effort: EffortLevel;
      subagent_model?: string;
      subagent_effort?: EffortLevel;
      mode: AgentRunMode;
      attachments?: Array<{ id: string; name: string; sha256: string; placement: string }>;
      token_budget: null;
    },
    onEvent: (eventType: string, data: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(this.url('/api/chat/stream'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        ...payload,
        sessionId: payload.session_id,
        attachmentIds: (payload.attachments ?? []).map((a) => a.id).filter(Boolean),
      }),
      signal,
    });

    if (!res.ok) {
      const txt = await res.text();
      onEvent('error', { message: txt || `HTTP ${res.status}` });
      return;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream') || !res.body) {
      const json = await res.json().catch(() => ({}));
      onEvent('complete', json as Record<string, unknown>);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = 'message';
    const terminalEvents = new Set([
      'prompt_result',
      'turn_finished',
      'session_aborted',
      'RUN_FINISHED',
      'complete',
      'done',
      'error',
    ]);

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) {
          currentEvent = 'message';
          continue;
        }
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const rawData = line.slice(5).trim();
          if (rawData === '[DONE]') {
            onEvent('done', {});
            await reader.cancel().catch(() => {});
            return;
          }
          try {
            const parsed = JSON.parse(rawData) as Record<string, unknown>;
            if (parsed.sessionId && String(parsed.sessionId) !== payload.session_id) {
              continue;
            }
            const inner =
              parsed.payload && typeof parsed.payload === 'object'
                ? (parsed.payload as Record<string, unknown>)
                : parsed;
            const evName = String(inner.kind || inner.type || parsed.event || currentEvent);
            onEvent(evName, { ...parsed, ...inner });
            if (terminalEvents.has(evName)) {
              await reader.cancel().catch(() => {});
              return;
            }
          } catch {
            onEvent(currentEvent, { delta: rawData });
          }
        }
      }
    }
    onEvent('done', {});
  }

  private normalizeBtwThread(raw: Record<string, unknown>, surface: 'chat' | 'notebook'): BtwThread {
    const rawQuote = raw.quote;
    const quoteObj =
      rawQuote && typeof rawQuote === 'object'
        ? (rawQuote as Record<string, unknown>)
        : { text: String(rawQuote ?? raw.quoteText ?? '') };
    const msgs = Array.isArray(raw.messages) ? raw.messages : [];
    return {
      id: String(raw.id ?? raw.btwId ?? raw.btw_id ?? `btw-${Date.now()}`),
      surface: (raw.surface === 'notebook' || raw.surface === 'chat' ? raw.surface : surface) as 'chat' | 'notebook',
      session_id: raw.sessionId ? String(raw.sessionId) : raw.session_id ? String(raw.session_id) : undefined,
      notebook_id: raw.notebook_id ? String(raw.notebook_id) : undefined,
      quote: {
        text: String(quoteObj.text ?? quoteObj.quoteText ?? ''),
        source_label: quoteObj.source_label ? String(quoteObj.source_label) : undefined,
        message_id: quoteObj.message_id ? String(quoteObj.message_id) : undefined,
      },
      messages: msgs.map((m, i) => {
        const rec = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
        return {
          id: String(rec.id ?? rec.messageId ?? `bm-${i}`),
          role: (rec.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
          content: String(rec.content ?? ''),
          model: rec.model ? String(rec.model) : undefined,
        };
      }),
    };
  }

  // Quote + BTW unified
  async listBtw(scopeId: string, surface: 'chat' | 'notebook') {
    const path =
      surface === 'chat'
        ? `/api/sessions/btw/list?sessionId=${encodeURIComponent(scopeId)}`
        : `/api/btw/list?notebook_id=${encodeURIComponent(scopeId)}&surface=notebook`;
    const res = await this.safeJson<{ threads?: Array<Record<string, unknown>> }>(path);
    if (!res.ok) return res;
    return {
      ok: true as const,
      data: {
        threads: Array.isArray(res.data.threads)
          ? res.data.threads.map((t) => this.normalizeBtwThread(t, surface))
          : [],
      },
    };
  }

  async askBtw(payload: {
    surface: 'chat' | 'notebook';
    session_id?: string;
    notebook_id?: string;
    quote: { text: string; source_label?: string; message_id?: string };
    question: string;
    model?: string;
    effort?: EffortLevel;
  }) {
    if (payload.surface === 'chat') {
      const res = await this.safeJson<{ thread?: Record<string, unknown>; answer?: string }>(
        '/api/sessions/btw/create',
        {
          method: 'POST',
          body: JSON.stringify({
            sessionId: payload.session_id,
            messageId: payload.quote.message_id,
            quoteText: payload.quote.text,
            quote: payload.quote,
            question: payload.question,
            surface: 'chat',
          }),
        },
      );
      if (!res.ok) return res;
      const thread = res.data.thread ? this.normalizeBtwThread(res.data.thread, 'chat') : undefined;
      return { ok: true as const, data: { thread, answer: res.data.answer } };
    }

    const createRes = await this.safeJson<{ thread?: Record<string, unknown>; btw?: Record<string, unknown> }>(
      '/api/btw/create',
      {
        method: 'POST',
        body: JSON.stringify({
          notebook_id: payload.notebook_id,
          quote: payload.quote.text,
          question: payload.question,
          surface: 'notebook',
        }),
      },
    );
    if (!createRes.ok) return createRes;
    const rawThread = createRes.data.thread ?? createRes.data.btw;
    if (!rawThread) return { ok: true as const, data: { answer: '' } };
    const norm = this.normalizeBtwThread(rawThread, 'notebook');
    const askRes = await this.safeJson<{ result?: { answer?: string } }>('/api/notebooks/btw/ask', {
      method: 'POST',
      body: JSON.stringify({
        btw_id: norm.id,
        question: payload.question,
        model: payload.model,
        effort: payload.effort,
      }),
    });
    if (askRes.ok && askRes.data.result?.answer) {
      norm.messages.push({
        id: `ba-${Date.now()}`,
        role: 'assistant',
        content: askRes.data.result.answer,
        model: payload.model,
      });
    }
    return { ok: true as const, data: { thread: norm, answer: askRes.ok ? askRes.data.result?.answer : undefined } };
  }

  async appendBtw(btwId: string, content: string, model?: string) {
    const isChat = btwId.startsWith('cbtw_');
    const path = isChat ? '/api/sessions/btw/append' : '/api/btw/append';
    const body = isChat
      ? { btwId, role: 'user', content, model }
      : { btw_id: btwId, role: 'user', content, model };
    const res = await this.safeJson<{ thread?: Record<string, unknown> }>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) return res;
    return {
      ok: true as const,
      data: {
        thread: res.data.thread ? this.normalizeBtwThread(res.data.thread, isChat ? 'chat' : 'notebook') : undefined,
      },
    };
  }

  promoteBtw(btwId: string, title?: string) {
    return this.safeJson('/api/btw/promote', {
      method: 'POST',
      body: JSON.stringify({ btw_id: btwId, title }),
    });
  }

  // Workspace / IDE / Git / LSP / Terminal
  getWorkspaceTree(path = '', maxDepth = 4) {
    return this.safeJson<{ entries?: WorkspaceEntry[]; root?: string }>(
      `/api/workspace/tree?path=${encodeURIComponent(path)}&max_depth=${maxDepth}`,
    );
  }

  readWorkspaceFile(path: string) {
    return this.safeJson<{ path: string; content: string; lines?: number }>(
      `/api/workspace/file?path=${encodeURIComponent(path)}`,
    );
  }

  writeWorkspaceFile(path: string, content: string) {
    return this.safeJson('/api/workspace/write', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    });
  }

  getGitStatus() {
    return this.safeJson<Record<string, unknown>>('/api/git/status');
  }

  getGitDiff(path?: string) {
    const q = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.safeJson<{ diff?: string; files?: Array<Record<string, unknown>> }>(`/api/git/diff${q}`);
  }

  queryLsp(action: 'problems' | 'outline' | 'hover' | 'definition', path?: string) {
    return this.safeJson<Record<string, unknown>>('/api/ide/lsp', {
      method: 'POST',
      body: JSON.stringify({ action, path }),
    });
  }

  createTerminal(cwd?: string, cols = 100, rows = 28) {
    const body: Record<string, unknown> = { cols, rows };
    if (cwd && cwd.trim()) body.cwd = cwd.trim();
    return this.safeJson<{ id?: string; terminal_id?: string; ptyId?: string; terminal?: { ptyId?: string } }>('/api/terminal/create', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  resizeTerminal(id: string, cols: number, rows: number) {
    return this.safeJson('/api/terminal/resize', {
      method: 'POST',
      body: JSON.stringify({ id, ptyId: id, cols, rows }),
    });
  }

  killTerminal(id: string) {
    return this.safeJson('/api/terminal/kill', {
      method: 'POST',
      body: JSON.stringify({ id, ptyId: id }),
    });
  }

  // Browser CDP (Isolated temp Chrome/Edge, zero Thorium)
  browserAction(action: 'launch' | 'status' | 'navigate' | 'click' | 'type' | 'screenshot' | 'close', body: Record<string, unknown> = {}) {
    if (action === 'status') return this.safeJson<Record<string, unknown>>('/api/browser/status');
    return this.safeJson<Record<string, unknown>>(`/api/browser/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  listWindows() {
    return this.safeJson<{ windows?: Array<{ hwnd: number; title: string; bounds?: number[] }> }>('/api/media/windows');
  }

  captureWindow(hwnd: number) {
    return this.safeJson<{ image_base64?: string; receipt?: Record<string, unknown> }>('/api/media/capture/window', {
      method: 'POST',
      body: JSON.stringify({ hwnd }),
    });
  }

  // Router, Stats, Benchmarks, Credentials
  getRouterState() {
    return this.safeJson<{ candidates?: RouterCandidate[]; breakers?: Record<string, boolean> }>('/api/router/state');
  }

  decideRoute(payload: {
    task_class: string;
    token_estimate: number;
    privacy_boundary: string;
    streaming: boolean;
    trip_provider?: string;
    reset_provider?: string;
  }) {
    return this.safeJson<Record<string, unknown>>('/api/route', {
      method: 'POST',
      body: JSON.stringify({
        requestId: `studio-route-${Date.now()}`,
        privacyTier: payload.privacy_boundary,
        taskRisk: payload.task_class,
        task_class: payload.task_class,
        token_estimate: payload.token_estimate,
        privacy_boundary: payload.privacy_boundary,
        streaming: payload.streaming,
        tripCandidate: payload.trip_provider,
        resetCandidate: payload.reset_provider,
        trip_provider: payload.trip_provider,
        reset_provider: payload.reset_provider,
      }),
    });
  }

  getSpotlightStats() {
    return this.safeJson<Record<string, unknown>>('/api/stats/spotlight');
  }

  getTraces() {
    return this.safeJson<Record<string, unknown>>('/api/traces');
  }

  getBenchmarks() {
    return this.safeJson<Record<string, unknown>>('/api/benchmarks/scoreboard');
  }

  listCredentials() {
    return this.safeJson<{ credentials?: Array<{ target: string; kind: string; label: string; masked_hint: string }> }>('/api/credentials');
  }

  saveCredential(target: string, kind: string, label: string, value: string) {
    return this.safeJson('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({ target, kind, label, secret: value, value }),
    });
  }

  deleteCredential(target: string) {
    return this.safeJson('/api/credentials/delete', {
      method: 'POST',
      body: JSON.stringify({ target }),
    });
  }

  // Swarm, Graphify, Memory, RAG, Skills, MCP, Hooks, Recipes
  getGraphSnapshot() {
    return this.safeJson<Record<string, unknown>>('/api/graph');
  }

  sendPeerMessage(from: string, to: string, payload: string, maxHops = 4) {
    return this.safeJson('/api/graph/send', {
      method: 'POST',
      body: JSON.stringify({ from, to, payload, max_hops: maxHops }),
    });
  }

  traverseGraphify(node: string, direction: 'forward' | 'reverse' | 'both', depth = 2) {
    return this.safeJson<Record<string, unknown>>(
      `/api/graph/traverse?entity=${encodeURIComponent(node)}&direction=${direction}&maxDepth=${depth}`,
    );
  }

  listMemory(namespace = '') {
    return this.safeJson<{ entries?: Array<Record<string, unknown>> }>(
      `/api/memory?namespace=${encodeURIComponent(namespace)}`,
    );
  }

  upsertMemory(namespace: string, key: string, value: string) {
    return this.safeJson('/api/memory/upsert', {
      method: 'POST',
      body: JSON.stringify({ namespace, key, tier: 'working', content: value, value }),
    });
  }

  eraseMemory(namespace: string, key: string, sha256Digest: string) {
    return this.safeJson<Record<string, unknown>>('/api/memory/erase', {
      method: 'POST',
      body: JSON.stringify({ namespace, key, sha256: sha256Digest }),
    });
  }

  planRag(query: string) {
    return this.safeJson<Record<string, unknown>>('/api/rag/query', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
  }

  listSkills(q = '') {
    return this.safeJson<{ skills?: Array<Record<string, unknown>> }>(`/api/skills?q=${encodeURIComponent(q)}`);
  }

  listMcp() {
    return this.safeJson<Record<string, unknown>>('/api/mcp/servers');
  }

  listHooks() {
    return this.safeJson<Record<string, unknown>>('/api/hooks');
  }

  listRecipes() {
    return this.safeJson<Record<string, unknown>>('/api/recipes');
  }

  // Atelier / Notebooks
  listNotebooks() {
    return this.safeJson<{ notebooks?: Array<Record<string, unknown>> }>('/api/notebooks');
  }

  createNotebook(title: string) {
    return this.safeJson<Record<string, unknown>>('/api/notebooks', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
  }

  listSources(notebookId: string) {
    return this.safeJson<{ sources?: Array<Record<string, unknown>> }>(
      `/api/notebooks/sources?notebook_id=${encodeURIComponent(notebookId)}`,
    );
  }

  ingestSource(notebookId: string, filename: string, text: string) {
    return this.safeJson('/api/notebooks/sources/ingest', {
      method: 'POST',
      body: JSON.stringify({ notebook_id: notebookId, filename, text }),
    });
  }

  askNotebook(notebookId: string, prompt: string, modelId?: string, effort?: EffortLevel) {
    return this.safeJson<Record<string, unknown>>('/api/notebooks/ask', {
      method: 'POST',
      body: JSON.stringify({ notebook_id: notebookId, query: prompt, prompt, model_id: modelId, effort }),
    });
  }

  generateArtifact(notebookId: string, kind: string, title?: string, focusPrompt?: string) {
    return this.safeJson<Record<string, unknown>>('/api/notebooks/artifacts/generate', {
      method: 'POST',
      body: JSON.stringify({ notebook_id: notebookId, kind, title, focus_prompt: focusPrompt }),
    });
  }

  listArtifacts(notebookId: string) {
    return this.safeJson<{ artifacts?: Array<Record<string, unknown>> }>(
      `/api/notebooks/artifacts?notebook_id=${encodeURIComponent(notebookId)}`,
    );
  }

  // OmniDrive
  listDownloads() {
    return this.safeJson<{ jobs?: Array<Record<string, unknown>> }>('/api/downloads/list');
  }

  startDownload(url: string, streams = 8, pacingMode = 'adaptive') {
    return this.safeJson<Record<string, unknown>>('/api/downloads/start', {
      method: 'POST',
      body: JSON.stringify({ url, streams, pacing_mode: pacingMode }),
    });
  }

  pauseDownload(jobId: string) {
    return this.safeJson('/api/downloads/pause', {
      method: 'POST',
      body: JSON.stringify({ job_id: jobId }),
    });
  }

  cancelDownload(jobId: string) {
    return this.safeJson('/api/downloads/cancel', {
      method: 'POST',
      body: JSON.stringify({ job_id: jobId }),
    });
  }

  probeMedia(urlOrPath: string) {
    return this.safeJson<Record<string, unknown>>('/api/downloads/media/ffprobe', {
      method: 'POST',
      body: JSON.stringify({ target: urlOrPath, url: urlOrPath }),
    });
  }

  crawlUrl(kind: 'moodle' | 'youtube' | 'web', url: string) {
    return this.safeJson<Record<string, unknown>>(`/api/downloads/crawl/${kind}`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  }

  listSchemaDrift(before = 'v1:id,title', after = 'v2:id,title,sha256') {
    return this.safeJson<Record<string, unknown>>('/api/downloads/schema-drift', {
      method: 'POST',
      body: JSON.stringify({ before, after }),
    });
  }

  sealCaptureBundle(sourceUrl = 'about:blank', parts: Array<{ name: string; text?: string }> = []) {
    return this.safeJson<Record<string, unknown>>('/api/downloads/capture-bundles', {
      method: 'POST',
      body: JSON.stringify({ sourceUrl, parts }),
    });
  }

  connectMultiplexedWs(
    onJson: (msg: { channel: string; event: string; seq?: number; sessionId?: string; payload: unknown }) => void,
    onBinary: (bytes: Uint8Array) => void,
    onStateChange?: (connected: boolean) => void,
  ): { sendJson: (msg: Record<string, unknown>) => void; sendPtyStdin: (id: string, data: string) => void; close: () => void } {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = this.baseUrl ? `${this.baseUrl.replace(/^http/, 'ws')}/ws` : `${proto}//${window.location.host}/ws`;
    let ws: WebSocket | null = null;
    let closedByUser = false;

    const connect = () => {
      if (closedByUser) return;
      try {
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => onStateChange?.(true);
        ws.onclose = () => {
          onStateChange?.(false);
          if (!closedByUser) setTimeout(connect, 2500);
        };
        ws.onerror = () => onStateChange?.(false);
        ws.onmessage = (ev) => {
          if (ev.data instanceof ArrayBuffer) {
            onBinary(new Uint8Array(ev.data));
          } else if (typeof ev.data === 'string') {
            try {
              const parsed = JSON.parse(ev.data);
              onJson(parsed);
            } catch {
              // ignore malformed text frame
            }
          }
        };
      } catch {
        onStateChange?.(false);
      }
    };

    if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
      connect();
    }

    return {
      sendJson: (msg) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      },
      sendPtyStdin: (id, data) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const encoded = new TextEncoder().encode(data);
        const idBytes = new TextEncoder().encode(id);
        const frame = new Uint8Array(2 + idBytes.length + encoded.length);
        frame[0] = 0x00;
        frame[1] = idBytes.length;
        frame.set(idBytes, 2);
        frame.set(encoded, 2 + idBytes.length);
        ws.send(frame.buffer);
      },
      close: () => {
        closedByUser = true;
        ws?.close();
      },
    };
  }
}

export const api = new StudioApiClient();
