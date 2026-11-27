import type {
  AgentRunMode,
  BtwThread,
  DualScopeModelConfig,
  EffortLevel,
  HealthSnapshot,
  ModelConfigEntry,
  RouterCandidate,
  SessionRecord,
  TelemetryWindow,
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

  private withQuery(path: string, params: Record<string, string | number | boolean | undefined | null>): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        qs.set(k, String(v));
      }
    }
    const encoded = qs.toString();
    if (!encoded) return path;
    return path.includes('?') ? `${path}&${encoded}` : `${path}?${encoded}`;
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

  async safeJson<T = Record<string, unknown>>(
    path: string,
    init?: RequestInit,
  ): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
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

  async safeText(path: string): Promise<{ ok: true; text: string; contentType: string } | { ok: false; error: ApiError }> {
    try {
      const res = await fetch(this.url(path));
      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          error: { status: res.status, code: `http_${res.status}`, message: text.slice(0, 200) || res.statusText },
        };
      }
      return { ok: true, text, contentType: res.headers.get('content-type') || 'text/plain' };
    } catch (e) {
      return {
        ok: false,
        error: { status: 0, code: 'network_unreachable', message: e instanceof Error ? e.message : 'Network error' },
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

  previewRewind(sessionId: string, turnIdx: number) {
    return this.safeJson<Record<string, unknown>>('/api/sessions/rewind/preview', {
      method: 'POST',
      body: JSON.stringify({ sessionId, session_id: sessionId, turn: turnIdx, turn_idx: turnIdx }),
    });
  }

  rewindSession(sessionId: string, turnIdx: number) {
    return this.safeJson('/api/sessions/rewind', {
      method: 'POST',
      body: JSON.stringify({ sessionId, session_id: sessionId, turn: turnIdx, turn_idx: turnIdx }),
    });
  }

  compactSession(sessionId: string) {
    return this.safeJson<Record<string, unknown>>('/api/sessions/compact', {
      method: 'POST',
      body: JSON.stringify({ sessionId, session_id: sessionId }),
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
    return this.safeJson<Record<string, unknown>>(path, {
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

  listSteerQueue() {
    return this.safeJson<Record<string, unknown>>('/api/steer');
  }

  enqueueSteer(prompt: string, mode: 'steer' | 'queue' | 'ADDITIVE_INTAKE' = 'ADDITIVE_INTAKE') {
    return this.safeJson<Record<string, unknown>>('/api/steer/enqueue', {
      method: 'POST',
      body: JSON.stringify({ prompt, mode, token_budget: null, tokenBudget: null }),
    });
  }

  updateSteerStatus(id: string, status: string) {
    return this.safeJson<Record<string, unknown>>('/api/v5/steer/status', {
      method: 'POST',
      body: JSON.stringify({ id, itemId: id, status }),
    });
  }

  reconcileSteer(sessionId?: string) {
    return this.safeJson<Record<string, unknown>>('/api/v5/steer/reconcile', {
      method: 'POST',
      body: JSON.stringify({ sessionId, session_id: sessionId }),
    });
  }

  getAgentCache(sessionId?: string) {
    return this.safeJson<Record<string, unknown>>(this.withQuery('/api/agent/cache', { sessionId }));
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
      research_mode?: 'auto' | 'deep' | 'off';
      think_mode?: 'auto' | 'deep' | 'off';
      rag_scope?: 'local_global' | 'local' | 'off';
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
        researchMode: payload.research_mode,
        thinkMode: payload.think_mode,
        ragScope: payload.rag_scope,
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
    const rawQuote = raw.quote ?? raw.anchorQuote;
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

  async appendBtw(btwId: string, content: string, model?: string, effort?: EffortLevel) {
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
    const thread = res.data.thread ? this.normalizeBtwThread(res.data.thread, isChat ? 'chat' : 'notebook') : undefined;
    if (!isChat && thread) {
      const askRes = await this.safeJson<{ result?: { answer?: string } }>('/api/notebooks/btw/ask', {
        method: 'POST',
        body: JSON.stringify({ btw_id: btwId, question: content, model, effort }),
      });
      if (askRes.ok && askRes.data.result?.answer) {
        thread.messages.push({
          id: `ba-${Date.now()}`,
          role: 'assistant',
          content: askRes.data.result.answer,
          model,
        });
      }
    }
    return { ok: true as const, data: { thread } };
  }

  promoteBtw(btwId: string, title?: string) {
    return this.safeJson('/api/btw/promote', {
      method: 'POST',
      body: JSON.stringify({ btw_id: btwId, title }),
    });
  }

  // Workspace / IDE / Git / LSP / Terminal / DAP
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

  queryLsp(action: 'problems' | 'outline' | 'hover' | 'definition', path?: string, line?: number, character?: number) {
    return this.safeJson<Record<string, unknown>>('/api/ide/lsp', {
      method: 'POST',
      body: JSON.stringify({ action, path, line, character }),
    });
  }

  listDapSessions() {
    return this.safeJson<Record<string, unknown>>('/api/dap/sessions');
  }

  launchDap(adapter: string, program: string, cwd?: string) {
    return this.safeJson<Record<string, unknown>>('/api/dap/launch', {
      method: 'POST',
      body: JSON.stringify({ adapter, program, cwd }),
    });
  }

  terminateDap(sessionId: string) {
    return this.safeJson<Record<string, unknown>>('/api/dap/terminate', {
      method: 'POST',
      body: JSON.stringify({ sessionId, session_id: sessionId }),
    });
  }

  listTerminals() {
    return this.safeJson<{ terminals?: Array<Record<string, unknown>> }>('/api/terminal/list');
  }

  createTerminal(cwd?: string, cols = 100, rows = 28) {
    const body: Record<string, unknown> = { cols, rows };
    if (cwd && cwd.trim()) body.cwd = cwd.trim();
    return this.safeJson<{ id?: string; terminal_id?: string; ptyId?: string; terminal?: { ptyId?: string } }>(
      '/api/terminal/create',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
  }

  resizeTerminal(id: string, cols: number, rows: number) {
    return this.safeJson('/api/terminal/resize', {
      method: 'POST',
      body: JSON.stringify({ id, ptyId: id, cols, rows }),
    });
  }

  sendTerminalInput(id: string, data: string) {
    return this.safeJson('/api/terminal/input', {
      method: 'POST',
      body: JSON.stringify({ id, ptyId: id, data }),
    });
  }

  killTerminal(id: string) {
    return this.safeJson('/api/terminal/kill', {
      method: 'POST',
      body: JSON.stringify({ id, ptyId: id }),
    });
  }

  // Browser CDP, Win32 Capture, OBS v5, Remote Control
  browserAction(
    action: 'launch' | 'status' | 'navigate' | 'click' | 'type' | 'screenshot' | 'snapshot' | 'close',
    body: Record<string, unknown> = {},
  ) {
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

  getObsStatus() {
    return this.safeJson<Record<string, unknown>>('/api/media/obs/status');
  }

  getMediaCapabilities() {
    return this.safeJson<Record<string, unknown>>('/api/media/capabilities');
  }

  getMediaIsolation() {
    return this.safeJson<Record<string, unknown>>('/api/media/isolation');
  }

  getRemoteStatus() {
    return this.safeJson<Record<string, unknown>>('/api/remote/status');
  }

  pairRemote(deviceLabel: string) {
    return this.safeJson<Record<string, unknown>>('/api/remote/pair', {
      method: 'POST',
      body: JSON.stringify({ deviceLabel, device_label: deviceLabel }),
    });
  }

  // Steer #17 Lab-Grade Network Diagnostics & Pro Speedtest
  getNetworkOverview(privacyMask = false) {
    return this.safeJson<Record<string, unknown>>(
      this.withQuery('/api/v5/network/overview', { privacy_mask: privacyMask }),
    );
  }

  getNetworkIdentity(force = false, privacyMask = false) {
    return this.safeJson<Record<string, unknown>>(
      this.withQuery('/api/v5/network/identity', { force, privacy_mask: privacyMask }),
    );
  }

  runDnsBenchmark(privacyMask = false) {
    return this.safeJson<Record<string, unknown>>(
      this.withQuery('/api/v5/network/dns/benchmark', { privacy_mask: privacyMask }),
      { method: 'POST', body: JSON.stringify({ privacy_mask: privacyMask }) },
    );
  }

  getProxyTls(force = false, privacyMask = false) {
    return this.safeJson<Record<string, unknown>>(
      this.withQuery('/api/v5/network/proxy-tls', { force, privacy_mask: privacyMask }),
      { method: 'POST', body: JSON.stringify({ force, privacy_mask: privacyMask }) },
    );
  }

  startSpeedtest(profile: 'quick' | 'standard' = 'quick') {
    return this.safeJson<Record<string, unknown>>('/api/v5/network/speedtest/start', {
      method: 'POST',
      body: JSON.stringify({ profile }),
    });
  }

  cancelSpeedtest(runId: string) {
    return this.safeJson<Record<string, unknown>>('/api/v5/network/speedtest/cancel', {
      method: 'POST',
      body: JSON.stringify({ runId, run_id: runId }),
    });
  }

  getSpeedtestHistory(limit = 30, privacyMask = false) {
    return this.safeJson<Record<string, unknown>>(
      this.withQuery('/api/v5/network/speedtest/history', { limit, privacy_mask: privacyMask }),
    );
  }

  // Steer #17 AI Telemetry, Host System, Alerts, Diffs, Exports
  getTelemetrySummary(params: {
    window?: TelemetryWindow;
    model?: string;
    role?: string;
    sessionId?: string;
    privacyMask?: boolean;
  } = {}) {
    return this.safeJson<Record<string, unknown>>(
      this.withQuery('/api/v5/telemetry/summary', {
        window: params.window ?? '24h',
        model: params.model,
        role: params.role,
        sessionId: params.sessionId,
        privacy_mask: params.privacyMask,
      }),
    );
  }

  getTelemetryRequests(params: {
    window?: TelemetryWindow;
    model?: string;
    role?: string;
    sessionId?: string;
    limit?: number;
    privacyMask?: boolean;
  } = {}) {
    return this.safeJson<Record<string, unknown>>(
      this.withQuery('/api/v5/telemetry/requests', {
        window: params.window ?? '24h',
        model: params.model,
        role: params.role,
        sessionId: params.sessionId,
        limit: params.limit ?? 100,
        privacy_mask: params.privacyMask,
      }),
    );
  }

  getSystemSnapshot(privacyMask = false) {
    return this.safeJson<Record<string, unknown>>(
      this.withQuery('/api/v5/system/snapshot', { privacy_mask: privacyMask }),
    );
  }

  getNvidiaHardware() {
    return this.safeJson<Record<string, unknown>>('/api/hardware/nvidia');
  }

  getSmartAlerts(privacyMask = false) {
    return this.safeJson<Record<string, unknown>>(
      this.withQuery('/api/v5/alerts', { privacy_mask: privacyMask }),
    );
  }

  getDiff(kind: 'sessions' | 'speedtests' | 'models' | 'benchmarks', a: string, b: string, privacyMask = false) {
    return this.safeJson<Record<string, unknown>>(
      this.withQuery(`/api/v5/diff/${kind}`, { a, b, privacy_mask: privacyMask }),
    );
  }

  fetchExport(format: 'json' | 'csv' | 'markdown' | 'diagnostic', privacyMask = false, window: TelemetryWindow = '24h') {
    return this.safeText(
      this.withQuery('/api/v5/export', { format, privacy_mask: privacyMask, window }),
    );
  }

  // Router Lab (v5 persistent SQLite + legacy fallback)
  async getRouterState(privacyMask = false) {
    const v5 = await this.safeJson<{ candidates?: RouterCandidate[]; breakers?: Record<string, boolean> } & Record<string, unknown>>(
      this.withQuery('/api/v5/router/state', { privacy_mask: privacyMask }),
    );
    if (v5.ok) return v5;
    return this.safeJson<{ candidates?: RouterCandidate[]; breakers?: Record<string, boolean> } & Record<string, unknown>>(
      '/api/router/state',
    );
  }

  async decideRoute(payload: {
    task_class: string;
    token_estimate: number;
    privacy_boundary: string;
    streaming: boolean;
    simulate?: boolean;
    trip_provider?: string;
    reset_provider?: string;
  }) {
    const body = JSON.stringify({
      requestId: `studio-route-${Date.now()}`,
      privacyTier: payload.privacy_boundary,
      taskRisk: payload.task_class,
      task_class: payload.task_class,
      token_estimate: payload.token_estimate,
      privacy_boundary: payload.privacy_boundary,
      streaming: payload.streaming,
      simulate: payload.simulate ?? true,
      tripCandidate: payload.trip_provider,
      resetCandidate: payload.reset_provider,
      trip_provider: payload.trip_provider,
      reset_provider: payload.reset_provider,
    });
    const v5 = await this.safeJson<Record<string, unknown>>('/api/v5/router/decide', { method: 'POST', body });
    if (v5.ok) return v5;
    return this.safeJson<Record<string, unknown>>('/api/route', { method: 'POST', body });
  }

  async tripRouterCandidate(candidateId: string, reason = 'manual_operator_trip') {
    const v5 = await this.safeJson<Record<string, unknown>>('/api/v5/router/trip', {
      method: 'POST',
      body: JSON.stringify({ candidateId, candidate_id: candidateId, provider: candidateId, reason }),
    });
    if (v5.ok) return v5;
    return this.decideRoute({
      task_class: 'coding',
      token_estimate: 8000,
      privacy_boundary: 'standard',
      streaming: true,
      trip_provider: candidateId,
    });
  }

  async resetRouterCandidate(candidateId: string) {
    const v5 = await this.safeJson<Record<string, unknown>>('/api/v5/router/reset', {
      method: 'POST',
      body: JSON.stringify({ candidateId, candidate_id: candidateId, provider: candidateId }),
    });
    if (v5.ok) return v5;
    return this.decideRoute({
      task_class: 'coding',
      token_estimate: 8000,
      privacy_boundary: 'standard',
      streaming: true,
      reset_provider: candidateId,
    });
  }

  getSpotlightStats() {
    return this.safeJson<Record<string, unknown>>('/api/stats/spotlight');
  }

  getTraces() {
    return this.safeJson<Record<string, unknown>>('/api/traces');
  }

  getBenchmarks(privacyMask = false) {
    return this.safeJson<Record<string, unknown>>(
      this.withQuery('/api/benchmarks/scoreboard', { privacy_mask: privacyMask }),
    );
  }

  async listCredentials(privacyMask = false) {
    const v5 = await this.safeJson<{ credentials?: Array<{ target: string; kind: string; label: string; masked_hint?: string; maskedHint?: string }> }>(
      this.withQuery('/api/v5/creds', { privacy_mask: privacyMask }),
    );
    if (v5.ok) return v5;
    return this.safeJson<{ credentials?: Array<{ target: string; kind: string; label: string; masked_hint?: string; maskedHint?: string }> }>(
      '/api/credentials',
    );
  }

  async saveCredential(target: string, kind: string, label: string, value: string) {
    const body = JSON.stringify({ target, kind, label, secret: value, value });
    const v5 = await this.safeJson('/api/v5/creds', { method: 'POST', body });
    if (v5.ok) return v5;
    return this.safeJson('/api/credentials', { method: 'POST', body });
  }

  async deleteCredential(target: string) {
    const body = JSON.stringify({ target });
    const v5 = await this.safeJson('/api/v5/creds/delete', { method: 'POST', body });
    if (v5.ok) return v5;
    return this.safeJson('/api/credentials/delete', { method: 'POST', body });
  }

  // Swarm, Graphify, Memory, RAG, Skills, MCP, Hooks, Recipes, Cordis
  getGraphSnapshot() {
    return this.safeJson<Record<string, unknown>>('/api/graph');
  }

  registerPeer(id: string, role: string, disjointPaths: string[]) {
    return this.safeJson<Record<string, unknown>>('/api/graph/peers', {
      method: 'POST',
      body: JSON.stringify({ id, role, disjointPaths, disjoint_paths: disjointPaths }),
    });
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

  retainMemory(bank: string, content: string, tags: string[] = []) {
    return this.safeJson<Record<string, unknown>>('/api/memory/retain', {
      method: 'POST',
      body: JSON.stringify({ bank, content, tags }),
    });
  }

  recallMemory(query: string, limit = 8) {
    return this.safeJson<Record<string, unknown>>('/api/memory/recall', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    });
  }

  reflectMemory(topic: string) {
    return this.safeJson<Record<string, unknown>>('/api/memory/reflect', {
      method: 'POST',
      body: JSON.stringify({ topic }),
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

  connectMcp(name: string, transport: string, endpoint: string) {
    return this.safeJson<Record<string, unknown>>('/api/mcp/servers', {
      method: 'POST',
      body: JSON.stringify({ name, transport, endpoint, url: endpoint, command: endpoint }),
    });
  }

  disconnectMcp(name: string) {
    return this.safeJson<Record<string, unknown>>('/api/mcp/servers/disconnect', {
      method: 'POST',
      body: JSON.stringify({ name, serverId: name }),
    });
  }

  searchMcpTools(q: string) {
    return this.safeJson<Record<string, unknown>>(`/api/mcp/tools/search?q=${encodeURIComponent(q)}`);
  }

  listHooks() {
    return this.safeJson<Record<string, unknown>>('/api/hooks');
  }

  toggleHook(id: string, enabled: boolean) {
    return this.safeJson<Record<string, unknown>>('/api/hooks/toggle', {
      method: 'POST',
      body: JSON.stringify({ id, hookId: id, enabled }),
    });
  }

  listRecipes() {
    return this.safeJson<Record<string, unknown>>('/api/recipes');
  }

  renderRecipe(name: string, params: Record<string, string> = {}) {
    return this.safeJson<Record<string, unknown>>('/api/recipes/render', {
      method: 'POST',
      body: JSON.stringify({ name, recipe: name, params }),
    });
  }

  listCordis() {
    return this.safeJson<Record<string, unknown>>('/api/plugins/cordis');
  }

  toggleCordis(id: string, enabled: boolean) {
    return this.safeJson<Record<string, unknown>>('/api/plugins/cordis/toggle', {
      method: 'POST',
      body: JSON.stringify({ id, pluginId: id, enabled }),
    });
  }

  rollbackCordis(id: string) {
    return this.safeJson<Record<string, unknown>>('/api/plugins/cordis/rollback', {
      method: 'POST',
      body: JSON.stringify({ id, pluginId: id }),
    });
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

  deleteSource(notebookId: string, sourceId: string) {
    return this.safeJson('/api/notebooks/sources/delete', {
      method: 'POST',
      body: JSON.stringify({ notebook_id: notebookId, source_id: sourceId }),
    });
  }

  transcribeAudio(notebookId: string, audioPath: string, language = 'auto') {
    return this.safeJson<Record<string, unknown>>('/api/notebooks/transcribe', {
      method: 'POST',
      body: JSON.stringify({ notebook_id: notebookId, path: audioPath, language }),
    });
  }

  listSyncTombstones(notebookId: string) {
    return this.safeJson<Record<string, unknown>>(
      `/api/notebooks/sync/tombstones?notebook_id=${encodeURIComponent(notebookId)}`,
    );
  }

  reconcileNotebookSync(notebookId: string) {
    return this.safeJson<Record<string, unknown>>('/api/notebooks/sync/reconcile', {
      method: 'POST',
      body: JSON.stringify({ notebook_id: notebookId }),
    });
  }

  askNotebook(
    notebookId: string,
    prompt: string,
    modelId?: string,
    effort?: EffortLevel,
    opts?: { preset?: 'explain' | 'verify' | 'summarize' | 'code'; quotes?: Array<{ text: string; sourceLabel?: string }> },
  ) {
    return this.safeJson<Record<string, unknown>>('/api/notebooks/ask', {
      method: 'POST',
      body: JSON.stringify({
        notebook_id: notebookId,
        query: prompt,
        prompt,
        model_id: modelId,
        effort,
        preset: opts?.preset,
        quotes: opts?.quotes,
      }),
    });
  }

  getNotebookSourceContent(notebookId: string, sourceId: string) {
    return this.safeText(
      this.withQuery('/api/notebooks/sources/content', { notebook_id: notebookId, source_id: sourceId }),
    );
  }

  // Steer #18-#20 Deep Research, Persistent Local+Global RAG & Sources Ledger
  getResearchStatus() {
    return this.safeJson<Record<string, unknown>>('/api/v5/research/status');
  }

  listResearchSources(tier = '') {
    return this.safeJson<Record<string, unknown>>(this.withQuery('/api/v5/research/sources', { tier }));
  }

  runResearchSearch(query: string, scope: 'web' | 'academic' | 'all' = 'all', autoFetch = true, maxResults = 8) {
    return this.safeJson<Record<string, unknown>>('/api/v5/research/search', {
      method: 'POST',
      body: JSON.stringify({ query, scope, autoFetch, maxResults }),
    });
  }

  fetchResearchUrls(urls: string[], tier: 'local' | 'global' = 'local', queryOrigin = '') {
    return this.safeJson<Record<string, unknown>>('/api/v5/research/fetch', {
      method: 'POST',
      body: JSON.stringify({ urls, tier, queryOrigin }),
    });
  }

  ingestResearchDoc(payload: { url: string; title?: string; content: string; contentType?: string; tier?: 'local' | 'global'; queryOrigin?: string }) {
    return this.safeJson<Record<string, unknown>>('/api/v5/research/ingest', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  queryPersistentRag(query: string, tier: 'local_global' | 'local' | 'global' = 'local_global', topK = 8) {
    return this.safeJson<Record<string, unknown>>('/api/v5/rag/query', {
      method: 'POST',
      body: JSON.stringify({ query, q: query, tier, topK, top_k: topK }),
    });
  }

  pinRagSource(citationId: string, targetTier: 'local' | 'global' | 'atelier' = 'global') {
    return this.safeJson<Record<string, unknown>>('/api/v5/rag/pin', {
      method: 'POST',
      body: JSON.stringify({ citationId, targetTier }),
    });
  }

  recordResearchClaim(sessionId: string, text: string, citations: string[], grade = 'VERIFIED', notes = '') {
    return this.safeJson<Record<string, unknown>>('/api/v5/research/claim', {
      method: 'POST',
      body: JSON.stringify({ sessionId, text, citations, grade, notes }),
    });
  }

  extractResearchTable(query: string, columns: string[], resultSetId?: string, topK = 10) {
    return this.safeJson<Record<string, unknown>>('/api/v5/research/table', {
      method: 'POST',
      body: JSON.stringify({ resultSetId, query, columns, topK }),
    });
  }

  exportResearchDossier(format: 'markdown' | 'json' = 'markdown', sessionId = '') {
    return this.safeText(this.withQuery('/api/v5/research/export', { format, session_id: sessionId }));
  }

  // Steer #18-#20 Deep Think Sessions
  listThinkSessions() {
    return this.safeJson<Record<string, unknown>>('/api/v5/think/sessions');
  }

  startThinkSession(sessionId: string, problem: string, effort: EffortLevel = 'max') {
    return this.safeJson<Record<string, unknown>>('/api/v5/think/start', {
      method: 'POST',
      body: JSON.stringify({ sessionId, problem, effort }),
    });
  }

  addThinkBranch(thinkId: string, label: string, hypothesis: string, failureModes: string[] = []) {
    return this.safeJson<Record<string, unknown>>('/api/v5/think/branch', {
      method: 'POST',
      body: JSON.stringify({ thinkId, id: thinkId, label, hypothesis, failureModes }),
    });
  }

  recordThinkFalsification(thinkId: string, branchLabel: string, checkCommand: string, passed: boolean, evidence: string) {
    return this.safeJson<Record<string, unknown>>('/api/v5/think/falsify', {
      method: 'POST',
      body: JSON.stringify({ thinkId, id: thinkId, branchLabel, checkCommand, passed, evidence }),
    });
  }

  recordThinkRedteam(thinkId: string, criticModel: string, critique: string, resolved: boolean) {
    return this.safeJson<Record<string, unknown>>('/api/v5/think/redteam', {
      method: 'POST',
      body: JSON.stringify({ thinkId, id: thinkId, criticModel, critique, resolved }),
    });
  }

  concludeThinkSession(thinkId: string, winner: string, rationale: string, confidence = 0.85) {
    return this.safeJson<Record<string, unknown>>('/api/v5/think/conclude', {
      method: 'POST',
      body: JSON.stringify({ thinkId, id: thinkId, winner, rationale, confidence }),
    });
  }

  // Steer #18-#20 12-Artifact Lifecycle OS, Auto-Learn & Hot/Cold Skill Vault + DAG
  listLifecycleArtifacts() {
    return this.safeJson<Record<string, unknown>>('/api/v5/lifecycle/artifacts');
  }

  upsertLifecycleArtifact(payload: {
    id?: string;
    kind: string;
    title: string;
    status?: string;
    content: string;
    owner?: string;
    projectToDisk?: boolean;
  }) {
    return this.safeJson<Record<string, unknown>>('/api/v5/lifecycle/upsert', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  linkLifecycleArtifacts(fromId: string, toId: string, relation: string) {
    return this.safeJson<Record<string, unknown>>('/api/v5/lifecycle/link', {
      method: 'POST',
      body: JSON.stringify({ fromId, toId, relation }),
    });
  }

  updateLifecycleTodo(id: string, status: 'pending' | 'in_progress' | 'done' | 'blocked', title?: string) {
    return this.safeJson<Record<string, unknown>>('/api/v5/lifecycle/todo', {
      method: 'POST',
      body: JSON.stringify({ id, status, title }),
    });
  }

  updateLifecycleDod(gateId: string, status: string, evidenceReceipt: string) {
    return this.safeJson<Record<string, unknown>>('/api/v5/lifecycle/dod', {
      method: 'POST',
      body: JSON.stringify({ gateId, id: gateId, status, evidenceReceipt }),
    });
  }

  writeLifecycleHandoff(summary: string, nextStep: string, agentNotes?: string) {
    return this.safeJson<Record<string, unknown>>('/api/v5/lifecycle/handoff', {
      method: 'POST',
      body: JSON.stringify({ summary, nextStep, agentNotes }),
    });
  }

  verifyLifecycleArtifact(content: string, path = 'artifact.md') {
    return this.safeJson<Record<string, unknown>>('/api/v5/lifecycle/verify', {
      method: 'POST',
      body: JSON.stringify({ content, path }),
    });
  }

  getSuperWorkflowState() {
    return this.safeJson<Record<string, unknown>>('/api/v5/lifecycle/super-state');
  }

  listLearnLessons() {
    return this.safeJson<Record<string, unknown>>('/api/v5/learn/lessons');
  }

  captureLearnLesson(payload: { title: string; lesson: string; scope?: 'project' | 'global'; category?: string; source?: string }) {
    return this.safeJson<Record<string, unknown>>('/api/v5/learn/capture', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  promoteLessonToSkill(lessonId: string, slug: string, triggerDescription: string) {
    return this.safeJson<Record<string, unknown>>('/api/v5/learn/promote-skill', {
      method: 'POST',
      body: JSON.stringify({ lessonId, slug, description: triggerDescription }),
    });
  }

  getLearnGapRadar() {
    return this.safeJson<Record<string, unknown>>('/api/v5/learn/gap-radar');
  }

  routeSkillsBilingual(query: string, topK = 6) {
    return this.safeJson<Record<string, unknown>>(this.withQuery('/api/v5/skills/route', { q: query, top_k: topK }));
  }

  composeSkillDag(query: string) {
    return this.safeJson<Record<string, unknown>>(this.withQuery('/api/v5/skills/dag', { q: query }));
  }

  searchSkillVault(query = '', limit = 30) {
    return this.safeJson<Record<string, unknown>>(this.withQuery('/api/v5/skills/vault', { q: query, limit }));
  }

  listSkillPipelines() {
    return this.safeJson<Record<string, unknown>>('/api/v5/skills/pipelines');
  }

  runSkillDoctor() {
    return this.safeJson<Record<string, unknown>>('/api/v5/skills/doctor');
  }

  codifySkill(payload: { slug: string; description: string; body: string; category?: string; dryRun?: boolean }) {
    return this.safeJson<Record<string, unknown>>('/api/v5/skills/codify', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  // Steer #19 OmniDrive v3.0 Protocol Studio API
  listDriveProviders(q = '', category = '') {
    return this.safeJson<Record<string, unknown>>(this.withQuery('/api/omni-drive/providers', { q, category }));
  }

  expandDriveBatch(input: string, exportFormat = 'auto') {
    return this.safeJson<Record<string, unknown>>('/api/omni-drive/batch-expand', {
      method: 'POST',
      body: JSON.stringify({ input, text: input, exportFormat }),
    });
  }

  exportDriveEf2(urls: string[]) {
    return this.safeJson<Record<string, unknown>>('/api/omni-drive/batch/export-ef2', {
      method: 'POST',
      body: JSON.stringify({ urls }),
    });
  }

  importDriveEf2(ef2Text: string) {
    return this.safeJson<Record<string, unknown>>('/api/omni-drive/batch/import-ef2', {
      method: 'POST',
      body: JSON.stringify({ content: ef2Text, ef2: ef2Text }),
    });
  }

  getDriveScheduler() {
    return this.safeJson<Record<string, unknown>>('/api/omni-drive/scheduler');
  }

  probeDriveUrl(url: string) {
    return this.safeJson<Record<string, unknown>>('/api/downloads/probe', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  }

  verifyDriveIntegrity(path: string, expectedSha256?: string, expectedCrc32c?: string) {
    return this.safeJson<Record<string, unknown>>('/api/omni-drive/integrity/verify', {
      method: 'POST',
      body: JSON.stringify({ path, expectedSha256, expectedCrc32c }),
    });
  }

  inspectDriveJournal(path: string) {
    return this.safeJson<Record<string, unknown>>('/api/omni-drive/journal/inspect', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  }

  listDriveHandoffs() {
    return this.safeJson<Record<string, unknown>>('/api/omni-drive/handoffs');
  }

  createDriveHandoff(url: string, reason = 'auth_required') {
    return this.safeJson<Record<string, unknown>>('/api/omni-drive/handoffs/create', {
      method: 'POST',
      body: JSON.stringify({ url, reason }),
    });
  }

  actDriveHandoff(action: 'open' | 'resolve' | 'cancel', ticketId: string) {
    return this.safeJson<Record<string, unknown>>(`/api/omni-drive/handoffs/${action}`, {
      method: 'POST',
      body: JSON.stringify({ ticketId, id: ticketId }),
    });
  }

  inspectMediaBox(hex: string) {
    return this.safeJson<Record<string, unknown>>('/api/omni-drive/inspect-media', {
      method: 'POST',
      body: JSON.stringify({ hex }),
    });
  }

  evaluateDriveCookies(url: string, setCookies: string[], sameSiteContext = 'lax') {
    return this.safeJson<Record<string, unknown>>('/api/omni-drive/cookies/evaluate', {
      method: 'POST',
      body: JSON.stringify({ url, setCookies, sameSiteContext }),
    });
  }

  recommendDriveStrategy(payload: { url?: string; fileSizeBytes?: number; supportsRange?: boolean; hasStrongEtag?: boolean; requiresAuth?: boolean }) {
    return this.safeJson<Record<string, unknown>>('/api/omni-drive/recommend', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  getDriveAimdStats() {
    return this.safeJson<Record<string, unknown>>('/api/omni-drive/aimd');
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

  muxMedia(videoPath: string, audioPath: string, outputPath: string) {
    return this.safeJson<Record<string, unknown>>('/api/downloads/media/mux', {
      method: 'POST',
      body: JSON.stringify({ video: videoPath, audio: audioPath, output: outputPath }),
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

  sealCaptureBundle(sourceUrl = 'https://example.com', parts: Array<{ name: string; text?: string }> = []) {
    return this.safeJson<Record<string, unknown>>('/api/downloads/capture-bundles', {
      method: 'POST',
      body: JSON.stringify({ sourceUrl, parts }),
    });
  }

  verifyCaptureBundle(bundleId: string) {
    return this.safeJson<Record<string, unknown>>('/api/downloads/capture-bundles/verify', {
      method: 'POST',
      body: JSON.stringify({ bundleId, bundle_id: bundleId }),
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
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ channel: 'pty', event: 'stdin', payload: { id, ptyId: id, data } }));
        }
      },
      close: () => {
        closedByUser = true;
        ws?.close();
      },
    };
  }
}

export const api = new StudioApiClient();
