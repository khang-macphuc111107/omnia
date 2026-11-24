import { createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { api } from '@/api/client';
import type {
  AgentRunMode,
  AttachmentItem,
  BrowserSessionState,
  BtwThread,
  ChatTurnMessage,
  DualScopeModelConfig,
  EffortLevel,
  HealthSnapshot,
  ModelConfigEntry,
  OpenEditorTab,
  SessionRecord,
  SteerQueueEntry,
  ThemeId,
  TopMode,
  WorkbenchTab,
  WorkspaceEntry,
} from '@/types';

// Global Shell state — `topMode` starts on `'chat'` and is NEVER mutated by async startup hydration
export const [topMode, setTopModeSignal] = createSignal<TopMode>('chat');
export const [workbenchTab, setWorkbenchTab] = createSignal<WorkbenchTab>('chat');
export const [sidebarOpen, setSidebarOpen] = createSignal<boolean>(true);
export const [ideChatDrawerOpen, setIdeChatDrawerOpen] = createSignal<boolean>(true);
export const [browserChatDrawerOpen, setBrowserChatDrawerOpen] = createSignal<boolean>(true);
export const [commandPaletteOpen, setCommandPaletteOpen] = createSignal<boolean>(false);
export const [btwDrawerOpen, setBtwDrawerOpen] = createSignal<boolean>(false);
export const [wsConnected, setWsConnected] = createSignal<boolean>(false);

const storedTheme = (typeof localStorage !== 'undefined' && (localStorage.getItem('omnia.studio.theme') as ThemeId)) || 'obsidian';
export const [themePref, setThemePrefSignal] = createSignal<ThemeId>(storedTheme);

export function applyTheme(pref: ThemeId): void {
  setThemePrefSignal(pref);
  let resolved = pref;
  if (pref === 'system') {
    resolved = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'alabaster'
      : 'obsidian';
  }
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('data-theme-pref', pref);
    document.documentElement.style.colorScheme = resolved === 'alabaster' ? 'light' : 'dark';
    const bgMap: Record<string, string> = {
      obsidian: '#080A0F',
      titanium: '#1F2328',
      alabaster: '#F6F5F0',
      blueprint: '#070E1B',
    };
    document.documentElement.style.backgroundColor = bgMap[resolved] || '#080A0F';
  }
  try {
    localStorage.setItem('omnia.studio.theme', pref);
  } catch {
    // ignore storage quota errors
  }
}

export function setTopMode(mode: TopMode): void {
  setTopModeSignal(mode);
  if (mode === 'chat' && workbenchTab() !== 'chat') {
    // Keep chosen workbench unless directly toggling back
  }
}

export function openWorkbench(tab: WorkbenchTab): void {
  setTopModeSignal('chat');
  setWorkbenchTab(tab);
}

// Live Health & Telemetry
export const [health, setHealth] = createStore<HealthSnapshot>({
  ok: false,
  crateCount: null,
  rustFiles: null,
  workingSetBytes: null,
  compiler: 'rustc',
  branch: 'omnia-sota-harness',
  tokenBudget: null,
  runtimeOnline: false,
});

// Unified SQLite Sessions
export const [sessions, setSessions] = createStore<SessionRecord[]>([]);
export const [activeSessionId, setActiveSessionId] = createSignal<string>('session-default');

// Chat & Agent Streaming State
export const [agentRunMode, setAgentRunMode] = createSignal<AgentRunMode>('builder');
export const [messages, setMessages] = createStore<ChatTurnMessage[]>([]);
export const [isStreaming, setIsStreaming] = createSignal<boolean>(false);
export const [steerQueue, setSteerQueue] = createStore<SteerQueueEntry[]>([]);
export const [composerDraft, setComposerDraft] = createSignal<string>('');
export const [composerCaret, setComposerCaret] = createSignal<number>(0);
export const [attachments, setAttachments] = createStore<AttachmentItem[]>([]);
export const [pendingPasteChoice, setPendingPasteChoice] = createSignal<{
  text: string;
  sha256: string;
  sizeBytes: number;
  name: string;
} | null>(null);

// Dual-Scope Main vs Subagent Model + Effort
export const DEFAULT_MODEL_CATALOG: ModelConfigEntry[] = [
  {
    spec: 'htmustc-claude/claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    provider: 'htmustc-claude',
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    contextWindow: 200000,
  },
  {
    spec: 'htmustc-openai/gpt-6.2-sol',
    name: 'GPT-6.2 Sol',
    provider: 'htmustc-openai',
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    contextWindow: 400000,
  },
  {
    spec: 'htmustc-gemini/gemini-3.8-pro',
    name: 'Gemini 3.8 Pro',
    provider: 'htmustc-gemini',
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'medium',
    contextWindow: 1000000,
  },
  {
    spec: 'htmustc-gemini/gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    provider: 'htmustc-gemini',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'low',
    contextWindow: 1000000,
  },
];

export const [modelCatalog, setModelCatalog] = createStore<ModelConfigEntry[]>(DEFAULT_MODEL_CATALOG);
export const [modelConfig, setModelConfig] = createStore<DualScopeModelConfig>({
  mainModel: 'htmustc-claude/claude-sonnet-5-5',
  mainEffort: 'high',
  subagentModel: 'htmustc-gemini/gemini-3.8-flash',
  subagentEffort: 'medium',
});

export async function updateDualModelConfig(patch: Partial<DualScopeModelConfig>): Promise<void> {
  const next: DualScopeModelConfig = { ...modelConfig, ...patch };
  setModelConfig(next);
  await api.saveModelsConfig(next);
}

// Unified Quote + BTW Side-Thread State
export const [btwThreads, setBtwThreads] = createStore<BtwThread[]>([]);
export const [activeBtwQuote, setActiveBtwQuote] = createSignal<{
  text: string;
  sourceLabel?: string;
  messageId?: string;
  surface: 'chat' | 'notebook';
  notebookId?: string;
} | null>(null);
export const [activeBtwThreadId, setActiveBtwThreadId] = createSignal<string | null>(null);

export function openQuoteBtw(quote: {
  text: string;
  sourceLabel?: string;
  messageId?: string;
  surface?: 'chat' | 'notebook';
  notebookId?: string;
}): void {
  setActiveBtwQuote({
    text: quote.text,
    sourceLabel: quote.sourceLabel,
    messageId: quote.messageId,
    surface: quote.surface ?? 'chat',
    notebookId: quote.notebookId,
  });
  setBtwDrawerOpen(true);
}

// IDE Workspace & Multi-Tab CodeMirror State
export const [workspaceRoot, setWorkspaceRoot] = createSignal<string>('');
export const [workspaceTree, setWorkspaceTree] = createStore<WorkspaceEntry[]>([]);
export const [openTabs, setOpenTabs] = createStore<OpenEditorTab[]>([]);
export const [activeTabPath, setActiveTabPath] = createSignal<string | null>(null);
export const [ideGitStatus, setIdeGitStatus] = createSignal<Record<string, unknown>>({});

// Browser CDP Isolated Session State
export const [browserState, setBrowserState] = createStore<BrowserSessionState>({
  active: false,
  url: 'https://example.com',
  cursorX: 0,
  cursorY: 0,
  manualControl: false,
  consoleLogs: [],
});

let currentStreamController: AbortController | null = null;

export function abortActiveStream(): void {
  if (currentStreamController) {
    currentStreamController.abort();
    currentStreamController = null;
  }
  setIsStreaming(false);
  void api.stopChat(activeSessionId());
}

export async function selectAndLoadSession(sessionId: string): Promise<void> {
  setActiveSessionId(sessionId);
  const res = await api.getSessionMessages(sessionId);
  if (res.ok && Array.isArray(res.data.messages)) {
    const loaded: ChatTurnMessage[] = res.data.messages.map((m, i) => ({
      id: String(m.id ?? `msg-${i}`),
      role: (m.role === 'user' || m.role === 'assistant' || m.role === 'system' ? m.role : 'assistant'),
      content: String(m.content ?? ''),
      thinking: m.thinking ? String(m.thinking) : undefined,
      model: m.model ? String(m.model) : undefined,
      effort: (m.effort as EffortLevel | undefined) ?? undefined,
      timestamp: Number(m.created_at ?? m.timestamp ?? Date.now()),
      turnIdx: Number(m.turn_idx ?? i),
      citations: Array.isArray(m.citations) ? m.citations.map(String) : undefined,
    }));
    setMessages(loaded);
  }
}

export async function sendComposerMessage(overridePrompt?: string): Promise<void> {
  const prompt = (overridePrompt ?? composerDraft()).trim();
  if (!prompt && attachments.length === 0) return;

  // If currently streaming, enqueue strictly as ADDITIVE_INTAKE Steer without dropping active stream
  if (isStreaming()) {
    const entry: SteerQueueEntry = {
      id: `steer-${Date.now()}`,
      prompt,
      mode: 'ADDITIVE_INTAKE',
      status: 'queued',
      createdAt: Date.now(),
      tokenBudget: null,
    };
    setSteerQueue(steerQueue.length, entry);
    if (!overridePrompt) setComposerDraft('');
    await api.steerChat(activeSessionId(), prompt, 'steer');
    return;
  }

  const userMsg: ChatTurnMessage = {
    id: `u-${Date.now()}`,
    role: 'user',
    content: prompt,
    mode: agentRunMode(),
    model: modelConfig.mainModel,
    effort: modelConfig.mainEffort,
    timestamp: Date.now(),
    turnIdx: messages.length,
    attachments: [...attachments],
  };

  const assistantId = `a-${Date.now() + 1}`;
  const assistantMsg: ChatTurnMessage = {
    id: assistantId,
    role: 'assistant',
    content: '',
    thinking: '',
    model: modelConfig.mainModel,
    effort: modelConfig.mainEffort,
    mode: agentRunMode(),
    timestamp: Date.now() + 1,
    turnIdx: messages.length + 1,
    toolCalls: [],
    streaming: true,
  };

  setMessages([...messages, userMsg, assistantMsg]);
  if (!overridePrompt) {
    setComposerDraft('');
    setAttachments([]);
  }
  setIsStreaming(true);

  const controller = new AbortController();
  currentStreamController = controller;

  const updateAssistant = (fn: (m: ChatTurnMessage) => ChatTurnMessage) => {
    const idx = messages.findIndex((m) => m.id === assistantId);
    if (idx !== -1) {
      setMessages(idx, fn(messages[idx]));
    }
  };

  try {
    await api.streamChatTurn(
      {
        session_id: activeSessionId(),
        prompt,
        model: modelConfig.mainModel,
        effort: modelConfig.mainEffort,
        subagent_model: modelConfig.subagentModel,
        subagent_effort: modelConfig.subagentEffort,
        mode: agentRunMode(),
        attachments: (userMsg.attachments ?? []).map((a) => ({
          id: a.id,
          name: a.name,
          sha256: a.sha256,
          placement: a.placement,
        })),
        token_budget: null,
      },
      (eventType, data) => {
        if (
          eventType === 'delta' ||
          eventType === 'text_delta' ||
          eventType === 'assistant_delta' ||
          eventType === 'delta_batch' ||
          eventType === 'TEXT_MESSAGE_CONTENT' ||
          eventType === 'message'
        ) {
          const textDelta = String(data.text_delta ?? data.textDelta ?? data.delta ?? data.content ?? '');
          const thinkDelta = String(data.thinking_delta ?? data.thinkingDelta ?? '');
          updateAssistant((prev) => ({
            ...prev,
            content: prev.content + textDelta,
            thinking: (prev.thinking ?? '') + thinkDelta,
          }));
        } else if (eventType === 'tool_start' || eventType === 'TOOL_CALL_START') {
          const callId = String(data.tool_call_id ?? data.toolCallId ?? data.id ?? `tc-${Date.now()}`);
          updateAssistant((prev) => ({
            ...prev,
            toolCalls: [
              ...(prev.toolCalls ?? []),
              {
                id: callId,
                name: String(data.tool_name ?? data.toolName ?? data.name ?? 'tool'),
                status: 'running',
                arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}),
              },
            ],
          }));
        } else if (eventType === 'tool_end' || eventType === 'TOOL_CALL_END') {
          const callId = String(data.tool_call_id ?? data.toolCallId ?? data.id ?? '');
          updateAssistant((prev) => ({
            ...prev,
            toolCalls: (prev.toolCalls ?? []).map((tc) =>
              tc.id === callId || (!callId && tc.status === 'running')
                ? {
                    ...tc,
                    status: data.is_error || data.isError ? 'error' : 'completed',
                    output: String(data.output ?? ''),
                    durationMs: Number(data.duration_ms ?? data.durationMs ?? 0),
                    diffPatch: data.diff_patch || data.diffPatch ? String(data.diff_patch ?? data.diffPatch) : tc.diffPatch,
                    diffPath: data.diff_path || data.diffPath ? String(data.diff_path ?? data.diffPath) : tc.diffPath,
                  }
                : tc,
            ),
          }));
        } else if (eventType === 'metrics') {
          updateAssistant((prev) => ({
            ...prev,
            tokensPerSec: Number(data.tokens_per_second ?? data.tokensPerSecond ?? prev.tokensPerSec ?? 0),
            costUsd: Number(data.total_cost_usd ?? data.totalCostUsd ?? prev.costUsd ?? 0),
            kvCacheHitRate: Number(data.kv_cache_hit_rate ?? data.kvCacheHitRate ?? prev.kvCacheHitRate ?? 0),
          }));
        } else if (eventType === 'error') {
          updateAssistant((prev) => ({
            ...prev,
            streaming: false,
            error: String(data.message ?? data.error ?? 'Stream error'),
          }));
        } else if (
          eventType === 'prompt_result' ||
          eventType === 'turn_finished' ||
          eventType === 'session_aborted' ||
          eventType === 'complete' ||
          eventType === 'done' ||
          eventType === 'RUN_FINISHED'
        ) {
          const finalContent = data.assistantText
            ? String(data.assistantText)
            : data.response
              ? String(data.response)
              : undefined;
          const errObj = data.error as { message?: string } | undefined;
          updateAssistant((prev) => ({
            ...prev,
            content: prev.content || finalContent || '',
            tokensPerSec: Number(data.tokensPerSecond ?? prev.tokensPerSec ?? 0),
            costUsd: Number(data.totalCostUsd ?? prev.costUsd ?? 0),
            error: errObj?.message ? String(errObj.message) : prev.error,
            streaming: false,
          }));
        }
      },
      controller.signal,
    );
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      updateAssistant((prev) => ({
        ...prev,
        streaming: false,
        error: err instanceof Error ? err.message : 'Studio request failed',
      }));
    } else {
      updateAssistant((prev) => ({ ...prev, streaming: false }));
    }
  } finally {
    setIsStreaming(false);
    currentStreamController = null;
    updateAssistant((prev) => ({ ...prev, streaming: false }));
  }
}

let startupInitialized = false;
export async function hydrateStudioStartup(): Promise<void> {
  if (startupInitialized) return;
  startupInitialized = true;

  // Startup hydration NEVER calls setTopMode — preserves user's selected mode/workbench
  const [healthRes, sessionsRes, cfgRes] = await Promise.all([
    api.getHealth(),
    api.listSessions(),
    api.getModelsConfig(),
  ]);

  let runtimeConfigured = false;
  if (healthRes.ok) {
    const d = healthRes.data;
    const runtimeReachable = d.rustRuntime === 'configured' || Boolean(d.runtimeOnline);
    runtimeConfigured = Boolean(d.providerConfigured === true);
    setHealth({
      ok: Boolean(d.ok ?? true),
      service: typeof d.service === 'string' ? d.service : 'omnia-studio',
      crateCount: typeof d.crateCount === 'number' ? d.crateCount : null,
      rustFiles: typeof d.rustFiles === 'number' ? d.rustFiles : null,
      workingSetBytes: typeof d.workingSetBytes === 'number' ? d.workingSetBytes : null,
      compiler: typeof d.compiler === 'string' ? d.compiler : 'rustc',
      branch: typeof d.branch === 'string' ? d.branch : 'omnia-sota-harness',
      tokenBudget: null,
      runtimeOnline: runtimeReachable,
    });
  }

  const modelsRes = runtimeConfigured ? await api.getModels() : null;

  if (sessionsRes.ok) {
    const raw = sessionsRes.data.sessions ?? sessionsRes.data.items ?? [];
    if (Array.isArray(raw) && raw.length > 0) {
      setSessions(raw);
      if (!activeSessionId() || activeSessionId() === 'session-default') {
        setActiveSessionId(raw[0].id);
      }
    }
  }

  if (modelsRes && modelsRes.ok && Array.isArray(modelsRes.data.models) && modelsRes.data.models.length > 0) {
    setModelCatalog(modelsRes.data.models);
  }

  if (cfgRes.ok) {
    if (cfgRes.data.config) {
      setModelConfig(cfgRes.data.config);
    } else if (Array.isArray(cfgRes.data.roles)) {
      const mainRole = cfgRes.data.roles.find((r) => (r.scope ?? r.role) === 'main');
      const subRole = cfgRes.data.roles.find((r) => (r.scope ?? r.role) === 'subagent');
      if (mainRole?.modelId) {
        setModelConfig('mainModel', mainRole.modelId);
        if (mainRole.effort) setModelConfig('mainEffort', mainRole.effort as EffortLevel);
      }
      if (subRole?.modelId) {
        setModelConfig('subagentModel', subRole.modelId);
        if (subRole.effort) setModelConfig('subagentEffort', subRole.effort as EffortLevel);
      }
    }
    if (Array.isArray(cfgRes.data.providers)) {
      const discovered: ModelConfigEntry[] = [];
      for (const p of cfgRes.data.providers) {
        const pid = String(p.providerId ?? 'provider');
        for (const m of p.models ?? []) {
          const id = String(m.id ?? '');
          if (!id) continue;
          discovered.push({
            spec: id.includes('/') ? id : `${pid}/${id}`,
            name: String(m.name ?? id),
            provider: pid,
            efforts: ['low', 'medium', 'high', 'max'],
            defaultEffort: 'high',
            contextWindow: Number(m.contextWindow ?? 200000),
          });
        }
      }
      if (discovered.length > 0 && (!modelsRes || !modelsRes.ok || !modelsRes.data.models?.length)) {
        setModelCatalog(discovered);
      }
    }
  }

  // Subscribe to multiplexed /ws updates without changing topMode
  api.connectMultiplexedWs(
    (msg) => {
      if (msg.channel === 'browser' && msg.payload && typeof msg.payload === 'object') {
        const p = msg.payload as Record<string, unknown>;
        if (typeof p.screenshot_base64 === 'string') setBrowserState('screenshotBase64', p.screenshot_base64);
        if (typeof p.cursor_x === 'number') setBrowserState('cursorX', p.cursor_x);
        if (typeof p.cursor_y === 'number') setBrowserState('cursorY', p.cursor_y);
        if (typeof p.cursor_label === 'string') setBrowserState('cursorLabel', p.cursor_label);
        if (typeof p.url === 'string') setBrowserState('url', p.url);
      }
    },
    () => {
      // Binary PTY output handled directly inside IdeWorkbench terminal listeners
    },
    setWsConnected,
  );
}
