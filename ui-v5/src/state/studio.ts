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
  ObservabilitySubTab,
  OpenEditorTab,
  RewindPreviewState,
  SessionRecord,
  SmartAlert,
  SteerQueueEntry,
  ThemeId,
  TopMode,
  WorkbenchTab,
  WorkspaceEntry,
} from '@/types';
import { downloadTextFile, maskJson, maskText } from '@/utils/privacy';

// Global Shell state — `topMode` starts on `'chat'` and is NEVER mutated by async startup hydration
export const [topMode, setTopModeSignal] = createSignal<TopMode>('chat');
export const [workbenchTab, setWorkbenchTab] = createSignal<WorkbenchTab>('chat');
export const [obsSubTab, setObsSubTab] = createSignal<ObservabilitySubTab>('telemetry');
export const [sidebarOpen, setSidebarOpen] = createSignal<boolean>(true);
export const [ideChatDrawerOpen, setIdeChatDrawerOpen] = createSignal<boolean>(true);
export const [browserChatDrawerOpen, setBrowserChatDrawerOpen] = createSignal<boolean>(true);
export const [commandPaletteOpen, setCommandPaletteOpen] = createSignal<boolean>(false);
export const [btwDrawerOpen, setBtwDrawerOpen] = createSignal<boolean>(false);
export const [steerDrawerOpen, setSteerDrawerOpen] = createSignal<boolean>(false);
export const [wsConnected, setWsConnected] = createSignal<boolean>(false);
export const [modelPickerTriggerSeq, setModelPickerTriggerSeq] = createSignal<number>(0);
export const [speedtestTriggerSeq, setSpeedtestTriggerSeq] = createSignal<number>(0);
export const [dnsBenchTriggerSeq, setDnsBenchTriggerSeq] = createSignal<number>(0);
export const [globalNotice, setGlobalNotice] = createSignal<string>('');

const storedPrivacy =
  typeof localStorage !== 'undefined' && localStorage.getItem('omnia.studio.privacyMask') === 'true';
export const [privacyMask, setPrivacyMaskSignal] = createSignal<boolean>(storedPrivacy);

export function setPrivacyMask(enabled: boolean): void {
  setPrivacyMaskSignal(enabled);
  try {
    localStorage.setItem('omnia.studio.privacyMask', String(enabled));
  } catch {
    // ignore storage quota errors
  }
  flashNotice(enabled ? 'Privacy Mask ON (IPs/MACs/SSIDs/paths masked)' : 'Privacy Mask OFF');
}

export function togglePrivacyMask(): void {
  setPrivacyMask(!privacyMask());
}

let noticeTimer: ReturnType<typeof setTimeout> | null = null;
export function flashNotice(msg: string, durationMs = 2800): void {
  setGlobalNotice(msg);
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => setGlobalNotice(''), durationMs);
}

const storedTheme =
  (typeof localStorage !== 'undefined' && (localStorage.getItem('omnia.studio.theme') as ThemeId)) || 'obsidian';
export const [themePref, setThemePrefSignal] = createSignal<ThemeId>(storedTheme);

export function applyTheme(pref: ThemeId): void {
  setThemePrefSignal(pref);
  let resolved = pref;
  if (pref === 'system') {
    resolved =
      typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches
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
}

export function openWorkbench(tab: WorkbenchTab): void {
  setTopModeSignal('chat');
  setWorkbenchTab(tab);
  if (tab === 'benchmarks') {
    setObsSubTab('benchmarks');
  }
}

export function openObservabilityTab(subTab: ObservabilitySubTab): void {
  setTopModeSignal('chat');
  setWorkbenchTab(subTab === 'benchmarks' ? 'benchmarks' : 'observability');
  setObsSubTab(subTab);
}

export function triggerQuickSpeedtest(): void {
  openObservabilityTab('network');
  setSpeedtestTriggerSeq((n) => n + 1);
}

export function triggerDnsBenchmark(): void {
  openObservabilityTab('network');
  setDnsBenchTriggerSeq((n) => n + 1);
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

// Live WS feeds for Network Speedtest & Smart Alerts
export const [smartAlerts, setSmartAlerts] = createStore<SmartAlert[]>([]);
export const [liveSpeedtestWsEvent, setLiveSpeedtestWsEvent] = createSignal<{
  event: string;
  payload: Record<string, unknown>;
  seq: number;
} | null>(null);
let speedtestWsSeq = 0;

// Unified SQLite Sessions
export const [sessions, setSessions] = createStore<SessionRecord[]>([]);
export const [activeSessionId, setActiveSessionId] = createSignal<string>('session-default');
export const [rewindPreview, setRewindPreview] = createSignal<RewindPreviewState | null>(null);

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

const ALL_FIVE_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// Dual-Scope Main vs Subagent Model + Effort (Steer #16 aligned: 5 effort levels, default max)
export const DEFAULT_MODEL_CATALOG: ModelConfigEntry[] = [
  {
    spec: 'htmustc-claude/claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    provider: 'htmustc-claude',
    efforts: ALL_FIVE_EFFORTS,
    defaultEffort: 'max',
    contextWindow: 200000,
  },
  {
    spec: 'htmustc-claude/claude-opus-5-5',
    name: 'Claude Opus 5.5',
    provider: 'htmustc-claude',
    efforts: ALL_FIVE_EFFORTS,
    defaultEffort: 'max',
    contextWindow: 200000,
  },
  {
    spec: 'htmustc-openai/gpt-6.2-sol',
    name: 'GPT-6.2 Sol',
    provider: 'htmustc-openai',
    efforts: ALL_FIVE_EFFORTS,
    defaultEffort: 'max',
    contextWindow: 400000,
  },
  {
    spec: 'htmustc-openai/gpt-6-luna',
    name: 'GPT-6 Luna',
    provider: 'htmustc-openai',
    efforts: ALL_FIVE_EFFORTS,
    defaultEffort: 'max',
    contextWindow: 400000,
  },
  {
    spec: 'htmustc-gemini/gemini-4-carbon',
    name: 'Gemini 4 Carbon',
    provider: 'htmustc-gemini',
    efforts: ALL_FIVE_EFFORTS,
    defaultEffort: 'max',
    contextWindow: 1000000,
  },
  {
    spec: 'htmustc-gemini/gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    provider: 'htmustc-gemini',
    efforts: ALL_FIVE_EFFORTS,
    defaultEffort: 'medium',
    contextWindow: 1000000,
  },
];

export const [modelCatalog, setModelCatalog] = createStore<ModelConfigEntry[]>(DEFAULT_MODEL_CATALOG);
export const [modelConfig, setModelConfig] = createStore<DualScopeModelConfig>({
  mainModel: 'htmustc-claude/claude-sonnet-5-5',
  mainEffort: 'max',
  subagentModel: 'htmustc-gemini/gemini-3.8-flash',
  subagentEffort: 'high',
});

export async function updateDualModelConfig(patch: Partial<DualScopeModelConfig>): Promise<void> {
  const next: DualScopeModelConfig = { ...modelConfig, ...patch };
  setModelConfig(next);
  const res = await api.saveModelsConfig(next);
  if (!res.ok) {
    flashNotice(`Model config save note (${res.error.code}): ${res.error.message}`);
  }
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
  setActiveBtwThreadId(null);
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

export async function refreshSteerQueue(): Promise<void> {
  const res = await api.listSteerQueue();
  if (res.ok) {
    const raw = (res.data.items ?? res.data.queue ?? res.data.entries) as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(raw)) {
      setSteerQueue(
        raw.map((item, idx) => ({
          id: String(item.id ?? item.itemId ?? `steer-${idx}`),
          prompt: String(item.prompt ?? item.text ?? item.message ?? ''),
          mode: (String(item.mode ?? 'ADDITIVE_INTAKE') as SteerQueueEntry['mode']),
          status: (String(item.status ?? 'queued') as SteerQueueEntry['status']),
          createdAt: Number(item.createdAtMs ?? item.created_at_ms ?? item.createdAt ?? Date.now()),
          tokenBudget: null,
        })),
      );
    }
  }
}

export async function refreshSmartAlerts(): Promise<void> {
  const res = await api.getSmartAlerts(privacyMask());
  if (res.ok) {
    const list = (res.data.alerts ?? res.data.items) as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(list)) {
      setSmartAlerts(
        list.map((a, idx) => ({
          id: String(a.id ?? `alert-${idx}`),
          severity: (a.severity === 'critical' || a.severity === 'warning' ? a.severity : 'info') as SmartAlert['severity'],
          category: String(a.category ?? 'telemetry'),
          title: String(a.title ?? a.code ?? 'System Notice'),
          detail: String(a.detail ?? a.message ?? ''),
          targetTab: (a.targetTab as ObservabilitySubTab | undefined) ?? 'telemetry',
          recordedAtMs: Number(a.recordedAtMs ?? Date.now()),
        })),
      );
    }
  }
}

export async function selectAndLoadSession(sessionId: string): Promise<void> {
  setActiveSessionId(sessionId);
  const res = await api.getSessionMessages(sessionId);
  if (res.ok && Array.isArray(res.data.messages)) {
    const loaded: ChatTurnMessage[] = res.data.messages.map((m, i) => ({
      id: String(m.id ?? `msg-${i}`),
      role: m.role === 'user' || m.role === 'assistant' || m.role === 'system' ? m.role : 'assistant',
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

export async function openRewindPreview(targetTurn: number): Promise<void> {
  const sid = activeSessionId();
  const clamped = Math.max(0, Math.min(targetTurn, Math.max(messages.length - 1, 0)));
  const res = await api.previewRewind(sid, clamped);
  if (res.ok) {
    const d = res.data;
    const files = Array.isArray(d.affectedFiles ?? d.affected_files)
      ? ((d.affectedFiles ?? d.affected_files) as unknown[]).map(String)
      : [];
    setRewindPreview({
      sessionId: sid,
      targetTurn: clamped,
      totalTurns: messages.length,
      turnsToDrop: Number(d.turnsToDrop ?? d.turns_to_drop ?? Math.max(0, messages.length - clamped - 1)),
      affectedFiles: files,
      diffPatch: String(d.diffPatch ?? d.diff_patch ?? d.patch ?? ''),
      summary: String(
        d.summary ?? d.note ?? `Rewind session ${sid} to turn T${clamped} (${Math.max(0, messages.length - clamped - 1)} turns truncated).`,
      ),
      checkpointHash: d.checkpointHash ? String(d.checkpointHash) : undefined,
    });
  } else {
    const dropped = messages.slice(clamped + 1);
    const localPatch = dropped
      .map((m, idx) => `--- turn/T${clamped + 1 + idx} (${m.role})\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-${m.content.slice(0, 140).replace(/\r?\n/g, ' ')}`)
      .join('\n');
    setRewindPreview({
      sessionId: sid,
      targetTurn: clamped,
      totalTurns: messages.length,
      turnsToDrop: dropped.length,
      affectedFiles: [],
      diffPatch: localPatch,
      summary: `Preview generated locally (${res.error.code}): rewinding to T${clamped} drops ${dropped.length} subsequent turn(s).`,
    });
  }
}

export async function confirmRewindExecution(): Promise<void> {
  const preview = rewindPreview();
  if (!preview) return;
  const res = await api.rewindSession(preview.sessionId, preview.targetTurn);
  setRewindPreview(null);
  if (res.ok) {
    await selectAndLoadSession(preview.sessionId);
    flashNotice(`Rewound session to turn T${preview.targetTurn}`);
  } else {
    flashNotice(`Rewind failed (${res.error.code}): ${res.error.message}`);
  }
}

export async function compactActiveSession(): Promise<void> {
  const res = await api.compactSession(activeSessionId());
  if (res.ok) {
    flashNotice(String(res.data.summary ?? res.data.message ?? 'Lakeview anchored compaction completed'));
    await selectAndLoadSession(activeSessionId());
  } else {
    flashNotice(`Compact failed (${res.error.code}): ${res.error.message}`);
  }
}

export function exportActiveSession(format: 'json' | 'markdown'): void {
  const masked = privacyMask();
  const payload = maskJson(
    {
      exportedAt: new Date().toISOString(),
      privacyMask: masked,
      sessionId: activeSessionId(),
      modelConfig: { ...modelConfig },
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        model: m.model,
        effort: m.effort,
        timestamp: m.timestamp,
      })),
    },
    masked,
  );
  if (format === 'json') {
    downloadTextFile(`omnia-session-${activeSessionId()}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  } else {
    const md = [
      `# Omnia Session Export (${maskText(activeSessionId(), masked)})`,
      `- Exported: ${payload.exportedAt}`,
      `- Privacy Mask: ${masked ? 'ON' : 'OFF'}`,
      `- Main Model: ${modelConfig.mainModel} [${modelConfig.mainEffort}]`,
      '',
      ...payload.messages.map((m, i) => `## Turn ${i} — ${m.role.toUpperCase()}\n\n${m.content}\n`),
    ].join('\n');
    downloadTextFile(`omnia-session-${activeSessionId()}.md`, md, 'text/markdown;charset=utf-8');
  }
  flashNotice(`Exported session (${format.toUpperCase()}, mask=${masked ? 'ON' : 'OFF'})`);
}

export async function triggerV5Export(format: 'json' | 'csv' | 'markdown' | 'diagnostic'): Promise<void> {
  const masked = privacyMask();
  const res = await api.fetchExport(format, masked, '24h');
  const ext = format === 'csv' ? 'csv' : format === 'markdown' ? 'md' : 'json';
  const mime =
    format === 'csv'
      ? 'text/csv;charset=utf-8'
      : format === 'markdown'
        ? 'text/markdown;charset=utf-8'
        : 'application/json;charset=utf-8';
  const filename = `omnia-observatory-${format}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;

  if (res.ok && res.text.trim().length > 0) {
    const body = masked ? maskText(res.text, true) : res.text;
    downloadTextFile(filename, body, mime);
    flashNotice(`Downloaded ${format.toUpperCase()} export (Privacy Mask ${masked ? 'ON' : 'OFF'})`);
    return;
  }

  // Deterministic client-side fallback when offline or endpoint unavailable
  const snapshot = maskJson(
    {
      exportedAt: new Date().toISOString(),
      format,
      privacyMask: masked,
      health: { ...health },
      modelConfig: { ...modelConfig },
      alerts: [...smartAlerts],
      sessionId: activeSessionId(),
      messageCount: messages.length,
    },
    masked,
  );
  if (format === 'csv') {
    const csv = [
      'metric,value',
      `exported_at,${snapshot.exportedAt}`,
      `privacy_mask,${masked}`,
      `crates,${snapshot.health.crateCount ?? ''}`,
      `working_set_bytes,${snapshot.health.workingSetBytes ?? ''}`,
      `main_model,${snapshot.modelConfig.mainModel}`,
      `main_effort,${snapshot.modelConfig.mainEffort}`,
      `alerts_count,${snapshot.alerts.length}`,
    ].join('\n');
    downloadTextFile(filename, csv, mime);
  } else if (format === 'markdown') {
    const md = [
      '# Omnia Studio Executive Report',
      `- Generated: ${snapshot.exportedAt}`,
      `- Privacy Mask: ${masked ? 'ON' : 'OFF'}`,
      `- Branch: ${snapshot.health.branch ?? 'omnia-sota-harness'}`,
      `- Main Model: ${snapshot.modelConfig.mainModel} (${snapshot.modelConfig.mainEffort})`,
      `- Active Alerts: ${snapshot.alerts.length}`,
    ].join('\n');
    downloadTextFile(filename, md, mime);
  } else {
    downloadTextFile(filename, JSON.stringify(snapshot, null, 2), mime);
  }
  flashNotice(`Exported local ${format.toUpperCase()} snapshot (Privacy Mask ${masked ? 'ON' : 'OFF'})`);
}

/**
 * Execute Studio slash commands locally when typed in the Composer so zero commands are dead.
 * Returns `true` when handled locally (caller should NOT dispatch as raw chat text).
 */
export async function handleSlashCommand(rawPrompt: string): Promise<boolean> {
  const trimmed = rawPrompt.trim();
  if (!trimmed.startsWith('/')) return false;
  const [cmdRaw, ...rest] = trimmed.split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const arg = rest.join(' ').trim();

  if (cmd === '/clear') {
    setComposerDraft('');
    setAttachments([]);
    flashNotice('Cleared draft and staged attachments');
    return true;
  }
  if (cmd === '/model') {
    setModelPickerTriggerSeq((n) => n + 1);
    setComposerDraft('');
    return true;
  }
  if (cmd === '/swarm') {
    openWorkbench('swarm');
    setComposerDraft('');
    return true;
  }
  if (cmd === '/obs' || cmd === '/status' || cmd === '/telemetry') {
    openObservabilityTab('telemetry');
    setComposerDraft('');
    return true;
  }
  if (cmd === '/net' || cmd === '/network') {
    openObservabilityTab('network');
    setComposerDraft('');
    return true;
  }
  if (cmd === '/speedtest') {
    triggerQuickSpeedtest();
    setComposerDraft('');
    return true;
  }
  if (cmd === '/privacy') {
    togglePrivacyMask();
    setComposerDraft('');
    return true;
  }
  if (cmd === '/compact') {
    setComposerDraft('');
    await compactActiveSession();
    return true;
  }
  if (cmd === '/fork') {
    setComposerDraft('');
    const res = await api.forkSession(activeSessionId());
    if (res.ok && res.data.session) {
      setSessions([res.data.session, ...sessions]);
      await selectAndLoadSession(res.data.session.id);
      flashNotice(`Forked session -> ${res.data.session.title}`);
    } else if (!res.ok) {
      flashNotice(`Fork failed (${res.error.code}): ${res.error.message}`);
    }
    return true;
  }
  if (cmd === '/rewind') {
    setComposerDraft('');
    const parsedTurn = arg ? Number.parseInt(arg, 10) : Math.max(messages.length - 2, 0);
    await openRewindPreview(Number.isFinite(parsedTurn) ? parsedTurn : 0);
    return true;
  }
  if (cmd === '/btw') {
    setComposerDraft('');
    openQuoteBtw({
      text: arg || messages[messages.length - 1]?.content.slice(0, 280) || 'Current conversation context',
      sourceLabel: 'Slash /btw',
      surface: 'chat',
    });
    return true;
  }
  if (cmd === '/steer' || cmd === '/queue') {
    setComposerDraft('');
    if (arg) {
      await enqueueAdditiveSteer(arg, cmd === '/queue' ? 'queue' : 'steer');
    }
    setSteerDrawerOpen(true);
    return true;
  }
  if (cmd === '/export') {
    setComposerDraft('');
    const fmt = (arg === 'csv' || arg === 'markdown' || arg === 'diagnostic' ? arg : 'json') as
      | 'json'
      | 'csv'
      | 'markdown'
      | 'diagnostic';
    await triggerV5Export(fmt);
    return true;
  }
  return false;
}

export async function enqueueAdditiveSteer(prompt: string, mode: 'steer' | 'queue' = 'queue'): Promise<void> {
  const clean = prompt.trim();
  if (!clean) return;
  const entry: SteerQueueEntry = {
    id: `steer-${Date.now()}`,
    prompt: clean,
    mode: mode === 'steer' ? 'steer' : 'ADDITIVE_INTAKE',
    status: 'queued',
    createdAt: Date.now(),
    tokenBudget: null,
  };
  setSteerQueue(steerQueue.length, entry);
  const res = await api.steerChat(activeSessionId(), clean, mode);
  if (!res.ok) {
    await api.enqueueSteer(clean, 'ADDITIVE_INTAKE');
  }
  await refreshSteerQueue();
  flashNotice(`Enqueued ADDITIVE_INTAKE (${mode}, token_budget: NULL)`);
}

export async function sendComposerMessage(overridePrompt?: string): Promise<void> {
  const prompt = (overridePrompt ?? composerDraft()).trim();
  if (!prompt && attachments.length === 0) return;

  if (!overridePrompt && (await handleSlashCommand(prompt))) {
    return;
  }

  // If currently streaming, enqueue strictly as ADDITIVE_INTAKE Steer without dropping active stream
  if (isStreaming()) {
    await enqueueAdditiveSteer(prompt, 'steer');
    if (!overridePrompt) setComposerDraft('');
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
    setModelCatalog(
      modelsRes.data.models.map((m) => ({
        ...m,
        efforts: m.efforts?.length ? m.efforts : ALL_FIVE_EFFORTS,
        defaultEffort: m.defaultEffort ?? 'max',
      })),
    );
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
            efforts: ALL_FIVE_EFFORTS,
            defaultEffort: 'max',
            contextWindow: Number(m.contextWindow ?? 200000),
          });
        }
      }
      if (discovered.length > 0 && (!modelsRes || !modelsRes.ok || !modelsRes.data.models?.length)) {
        setModelCatalog(discovered);
      }
    }
  }

  // Hydrate Steer Queue and Smart Alerts passively in background
  void refreshSteerQueue();
  void refreshSmartAlerts();

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
      } else if (msg.channel === 'network' && msg.payload && typeof msg.payload === 'object') {
        setLiveSpeedtestWsEvent({
          event: msg.event,
          payload: msg.payload as Record<string, unknown>,
          seq: ++speedtestWsSeq,
        });
      } else if (msg.channel === 'alerts' && msg.payload && typeof msg.payload === 'object') {
        const p = msg.payload as Record<string, unknown>;
        if (Array.isArray(p.alerts)) {
          setSmartAlerts(p.alerts as SmartAlert[]);
        } else if (p.title || p.code) {
          const nextAlert: SmartAlert = {
            id: String(p.id ?? `ws-alert-${Date.now()}`),
            severity: (p.severity === 'critical' || p.severity === 'warning' ? p.severity : 'info'),
            category: String(p.category ?? 'system'),
            title: String(p.title ?? p.code),
            detail: String(p.detail ?? p.message ?? ''),
            recordedAtMs: Date.now(),
          };
          setSmartAlerts((prev) => [nextAlert, ...prev.slice(0, 19)]);
        }
      }
    },
    () => {
      // Binary PTY output handled directly inside IdeWorkbench terminal listeners
    },
    setWsConnected,
  );
}
