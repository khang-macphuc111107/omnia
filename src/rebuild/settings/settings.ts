import { useCallback, useSyncExternalStore } from "react";

export const SETTINGS_VERSION = 1 as const;
export const SETTINGS_STORAGE_KEY = "omnia.rebuild.settings.v1";
const SETTINGS_CHANNEL = "omnia.rebuild.settings";

export type RebuildTheme = "dark" | "light";
/**
 * `ultra` is a workflow policy, not a provider enum.  At dispatch time the
 * runtime resolves it to the selected model's highest supported effort and
 * enables the dynamic workflow escalation policy.  Keeping it in the
 * persisted schema means a session can round-trip the user's intent without
 * pretending every provider accepts an `ultra` request.
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type RetryJitter = "none" | "full" | "decorrelated";

export interface RebuildSettings {
  version: typeof SETTINGS_VERSION;
  theme: RebuildTheme;
  context: {
    compactTokens: number;
    toolOutputTokens: number;
    maxInputTokens: number;
    preserveRecentTurns: number;
    includeToolArguments: boolean;
  };
  model: {
    providerProfileId: string;
    defaultModel: string;
    defaultEffort: ReasoningEffort;
    ultraDynamicWorkflow: boolean;
    allowPerSessionHotSwap: boolean;
    fallbackModels: string[];
  };
  routing: {
    providerOrder: string[];
    compareFanout: number;
    maxConcurrentRequests: number;
    requireExplicitProvider: boolean;
  };
  workflow: {
    brainstormPasses: number;
    planPasses: number;
    atomicBreakdown: boolean;
    requireEvidenceBeforeDone: boolean;
    showProgressDetails: boolean;
    allowPromptQueue: boolean;
  };
  browserComputer: {
    enableBrowserHarness: boolean;
    enableComputerHarness: boolean;
    headlessWhenPossible: boolean;
    captureOnDemand: boolean;
    domLayerBudget: number;
    screenshotQuality: "balanced" | "text" | "visual";
  };
  memoryRag: {
    enableMemory: boolean;
    enableRag: boolean;
    retrievalTopK: number;
    chunkTokens: number;
    rerank: boolean;
    persistReceipts: boolean;
  };
  privacyPermissions: {
    allowWebSearch: boolean;
    allowNetworkProviders: boolean;
    allowNativeFilesystem: boolean;
    allowOsAutomation: boolean;
    requireApprovalForWrites: boolean;
    redactSensitiveLogs: boolean;
  };
  concurrency: {
    maxSessions: number;
    maxSubagents: number;
    maxToolCallsPerRun: number;
    maxBackgroundJobs: number;
  };
  retry: {
    retryOnAnyError: boolean;
    delaySeconds: number;
    multiplier: number;
    maxAttempts: number;
    maxElapsedSeconds: number;
    maxSingleDelaySeconds: number;
    jitter: RetryJitter;
    providerFallback: boolean;
    modelFallback: boolean;
    promptRepair: boolean;
  };
  telemetry: {
    enabled: boolean;
    persistRequestLog: boolean;
    includePromptContent: boolean;
    showCost: boolean;
    retentionDays: number;
  };
  appearance: {
    density: "compact" | "comfortable";
    reduceMotion: boolean;
    fontScale: number;
    showToolDetails: boolean;
  };
}

export const DEFAULT_REBUILD_SETTINGS: RebuildSettings = {
  version: SETTINGS_VERSION,
  theme: "dark",
  context: { compactTokens: 200_000, toolOutputTokens: 10_000, maxInputTokens: 200_000, preserveRecentTurns: 12, includeToolArguments: false },
  model: { providerProfileId: "", defaultModel: "auto", defaultEffort: "high", ultraDynamicWorkflow: true, allowPerSessionHotSwap: true, fallbackModels: [] },
  routing: { providerOrder: ["local", "openai", "anthropic", "google"], compareFanout: 2, maxConcurrentRequests: 4, requireExplicitProvider: false },
  workflow: { brainstormPasses: 3, planPasses: 3, atomicBreakdown: true, requireEvidenceBeforeDone: true, showProgressDetails: true, allowPromptQueue: true },
  browserComputer: { enableBrowserHarness: false, enableComputerHarness: false, headlessWhenPossible: true, captureOnDemand: true, domLayerBudget: 3, screenshotQuality: "balanced" },
  memoryRag: { enableMemory: true, enableRag: true, retrievalTopK: 8, chunkTokens: 800, rerank: true, persistReceipts: true },
  privacyPermissions: { allowWebSearch: true, allowNetworkProviders: true, allowNativeFilesystem: true, allowOsAutomation: false, requireApprovalForWrites: true, redactSensitiveLogs: true },
  concurrency: { maxSessions: 8, maxSubagents: 8, maxToolCallsPerRun: 64, maxBackgroundJobs: 4 },
  retry: { retryOnAnyError: true, delaySeconds: 5, multiplier: 1, maxAttempts: 0, maxElapsedSeconds: 0, maxSingleDelaySeconds: 300, jitter: "none", providerFallback: true, modelFallback: true, promptRepair: true },
  telemetry: { enabled: true, persistRequestLog: true, includePromptContent: false, showCost: true, retentionDays: 30 },
  appearance: { density: "comfortable", reduceMotion: false, fontScale: 1, showToolDetails: false },
};

type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown, fallback: number, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};
const bool = (value: unknown, fallback: boolean): boolean => typeof value === "boolean" ? value : fallback;
const text = (value: unknown, fallback: string, max = 200): string => typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim().slice(0, max) : fallback;
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
const arr = (value: unknown, fallback: string[]): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim().slice(0, 100)).slice(0, 16) : fallback;
const child = (root: UnknownRecord, key: string): UnknownRecord => isRecord(root[key]) ? root[key] : {};

export function normalizeRebuildSettings(input: unknown): RebuildSettings {
  const root = isRecord(input) ? input : {};
  const context = child(root, "context");
  const model = child(root, "model");
  const routing = child(root, "routing");
  const workflow = child(root, "workflow");
  const browserComputer = child(root, "browserComputer");
  const memoryRag = child(root, "memoryRag");
  const privacyPermissions = child(root, "privacyPermissions");
  const concurrency = child(root, "concurrency");
  const retry = child(root, "retry");
  const telemetry = child(root, "telemetry");
  const appearance = child(root, "appearance");
  return {
    version: SETTINGS_VERSION,
    theme: oneOf(root.theme, ["dark", "light"] as const, DEFAULT_REBUILD_SETTINGS.theme),
    context: {
      compactTokens: num(context.compactTokens, 200_000, 10_000, 2_000_000),
      toolOutputTokens: num(context.toolOutputTokens, 10_000, 1_000, 100_000),
      maxInputTokens: num(context.maxInputTokens, 200_000, 10_000, 2_000_000),
      preserveRecentTurns: num(context.preserveRecentTurns, 12, 1, 100),
      includeToolArguments: bool(context.includeToolArguments, false),
    },
    model: {
      providerProfileId: text(model.providerProfileId, "", 256),
      defaultModel: text(model.defaultModel, "auto", 512),
      defaultEffort: oneOf(model.defaultEffort, ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const, "high"),
      ultraDynamicWorkflow: bool(model.ultraDynamicWorkflow, true),
      allowPerSessionHotSwap: bool(model.allowPerSessionHotSwap, true),
      fallbackModels: arr(model.fallbackModels, []),
    },
    routing: {
      providerOrder: arr(routing.providerOrder, DEFAULT_REBUILD_SETTINGS.routing.providerOrder),
      compareFanout: num(routing.compareFanout, 2, 2, 4),
      maxConcurrentRequests: num(routing.maxConcurrentRequests, 4, 1, 32),
      requireExplicitProvider: bool(routing.requireExplicitProvider, false),
    },
    workflow: {
      brainstormPasses: num(workflow.brainstormPasses, 3, 0, 10),
      planPasses: num(workflow.planPasses, 3, 0, 10),
      atomicBreakdown: bool(workflow.atomicBreakdown, true),
      requireEvidenceBeforeDone: bool(workflow.requireEvidenceBeforeDone, true),
      showProgressDetails: bool(workflow.showProgressDetails, true),
      allowPromptQueue: bool(workflow.allowPromptQueue, true),
    },
    browserComputer: {
      enableBrowserHarness: bool(browserComputer.enableBrowserHarness, false),
      enableComputerHarness: bool(browserComputer.enableComputerHarness, false),
      headlessWhenPossible: bool(browserComputer.headlessWhenPossible, true),
      captureOnDemand: bool(browserComputer.captureOnDemand, true),
      domLayerBudget: num(browserComputer.domLayerBudget, 3, 1, 12),
      screenshotQuality: oneOf(browserComputer.screenshotQuality, ["balanced", "text", "visual"] as const, "balanced"),
    },
    memoryRag: {
      enableMemory: bool(memoryRag.enableMemory, true), enableRag: bool(memoryRag.enableRag, true),
      retrievalTopK: num(memoryRag.retrievalTopK, 8, 1, 50), chunkTokens: num(memoryRag.chunkTokens, 800, 100, 8_000),
      rerank: bool(memoryRag.rerank, true), persistReceipts: bool(memoryRag.persistReceipts, true),
    },
    privacyPermissions: {
      allowWebSearch: bool(privacyPermissions.allowWebSearch, true), allowNetworkProviders: bool(privacyPermissions.allowNetworkProviders, true),
      allowNativeFilesystem: bool(privacyPermissions.allowNativeFilesystem, true), allowOsAutomation: bool(privacyPermissions.allowOsAutomation, false),
      requireApprovalForWrites: bool(privacyPermissions.requireApprovalForWrites, true), redactSensitiveLogs: bool(privacyPermissions.redactSensitiveLogs, true),
    },
    concurrency: {
      maxSessions: num(concurrency.maxSessions, 8, 1, 64), maxSubagents: num(concurrency.maxSubagents, 8, 0, 100),
      maxToolCallsPerRun: num(concurrency.maxToolCallsPerRun, 64, 1, 1_000), maxBackgroundJobs: num(concurrency.maxBackgroundJobs, 4, 0, 32),
    },
    retry: {
      retryOnAnyError: bool(retry.retryOnAnyError, true), delaySeconds: num(retry.delaySeconds, 5, 0, 86_400),
      multiplier: num(retry.multiplier, 1, 1, 10), maxAttempts: num(retry.maxAttempts, 0, 0, 10_000),
      maxElapsedSeconds: num(retry.maxElapsedSeconds, 0, 0, 86_400 * 30), maxSingleDelaySeconds: num(retry.maxSingleDelaySeconds, 300, 1, 86_400),
      jitter: oneOf(retry.jitter, ["none", "full", "decorrelated"] as const, "none"), providerFallback: bool(retry.providerFallback, true),
      modelFallback: bool(retry.modelFallback, true), promptRepair: bool(retry.promptRepair, true),
    },
    telemetry: {
      enabled: bool(telemetry.enabled, true), persistRequestLog: bool(telemetry.persistRequestLog, true), includePromptContent: bool(telemetry.includePromptContent, false),
      showCost: bool(telemetry.showCost, true), retentionDays: num(telemetry.retentionDays, 30, 1, 3650),
    },
    appearance: {
      density: oneOf(appearance.density, ["compact", "comfortable"] as const, "comfortable"), reduceMotion: bool(appearance.reduceMotion, false),
      fontScale: num(appearance.fontScale, 1, 0.8, 1.4), showToolDetails: bool(appearance.showToolDetails, false),
    },
  };
}

function cloneSettings(settings: RebuildSettings): RebuildSettings {
  return normalizeRebuildSettings(JSON.parse(JSON.stringify(settings)) as unknown);
}

export function parseStoredSettings(raw: string | null): RebuildSettings {
  if (!raw) return cloneSettings(DEFAULT_REBUILD_SETTINGS);
  try { return normalizeRebuildSettings(JSON.parse(raw) as unknown); } catch { return cloneSettings(DEFAULT_REBUILD_SETTINGS); }
}

export function serializeSettings(settings: RebuildSettings): string {
  return JSON.stringify(normalizeRebuildSettings(settings));
}

type Listener = () => void;
const fallbackStorage = new Map<string, string>();
const SETTINGS_META_KEY = "__omniaMeta";
type SettingsMeta = { revision: number; writerId: string; updatedAt: string };
type StoredSettings = RebuildSettings & { [SETTINGS_META_KEY]?: Partial<SettingsMeta> };
const instanceWriterId = `renderer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let currentRevision = 0;
let currentWriterId = instanceWriterId;
let currentSettings = loadInitialSettings();
const listeners = new Set<Listener>();
let channel: BroadcastChannel | undefined;
let storageListenerInstalled = false;

function safeMeta(value: unknown): SettingsMeta | null {
  if (!isRecord(value)) return null;
  const revision = typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : null;
  const writerId = typeof value.writerId === "string" && value.writerId.trim().length > 0 ? value.writerId.trim().slice(0, 120) : null;
  const updatedAt = typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : new Date(0).toISOString();
  return revision === null || writerId === null ? null : { revision, writerId, updatedAt };
}

function parseStoredSnapshot(raw: string | null): { settings: RebuildSettings; meta: SettingsMeta | null } {
  if (!raw) return { settings: cloneSettings(DEFAULT_REBUILD_SETTINGS), meta: null };
  try {
    const parsed = JSON.parse(raw) as StoredSettings;
    const meta = safeMeta(parsed?.[SETTINGS_META_KEY]);
    return { settings: normalizeRebuildSettings(parsed), meta };
  } catch {
    return { settings: cloneSettings(DEFAULT_REBUILD_SETTINGS), meta: null };
  }
}

function loadInitialSettings(): RebuildSettings {
  if (typeof window === "undefined") return cloneSettings(DEFAULT_REBUILD_SETTINGS);
  try {
    const snapshot = parseStoredSnapshot(window.localStorage?.getItem(SETTINGS_STORAGE_KEY) ?? fallbackStorage.get(SETTINGS_STORAGE_KEY) ?? null);
    if (snapshot.meta) {
      currentRevision = snapshot.meta.revision;
      currentWriterId = snapshot.meta.writerId;
    }
    return snapshot.settings;
  } catch {
    return parseStoredSettings(fallbackStorage.get(SETTINGS_STORAGE_KEY) ?? null);
  }
}

function persist(next: RebuildSettings, meta: SettingsMeta): void {
  const serialized = JSON.stringify({ ...normalizeRebuildSettings(next), [SETTINGS_META_KEY]: meta });
  fallbackStorage.set(SETTINGS_STORAGE_KEY, serialized);
  try { window.localStorage?.setItem(SETTINGS_STORAGE_KEY, serialized); } catch { /* private browsing or test runtime */ }
}

function notify(next: RebuildSettings, persistChanges: boolean, meta: SettingsMeta = { revision: currentRevision, writerId: currentWriterId, updatedAt: new Date().toISOString() }): void {
  currentSettings = cloneSettings(next);
  currentRevision = meta.revision;
  currentWriterId = meta.writerId;
  if (persistChanges) {
    persist(currentSettings, meta);
  }
  for (const listener of listeners) listener();
}

function compareMeta(left: SettingsMeta, right: SettingsMeta): number {
  if (left.revision !== right.revision) return left.revision - right.revision;
  return left.writerId.localeCompare(right.writerId);
}

function acceptRemote(next: unknown, metaValue: unknown): void {
  const incoming = safeMeta(metaValue);
  if (!incoming || compareMeta(incoming, { revision: currentRevision, writerId: currentWriterId, updatedAt: "" }) <= 0) return;
  const normalized = normalizeRebuildSettings(next);
  notify(normalized, true, incoming);
}

function installStorageListener(): void {
  if (storageListenerInstalled || typeof window === "undefined") return;
  storageListenerInstalled = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== SETTINGS_STORAGE_KEY || !event.newValue) return;
    try {
      const snapshot = parseStoredSnapshot(event.newValue);
      if (snapshot.meta) acceptRemote(snapshot.settings, snapshot.meta);
    } catch { /* malformed cross-tab data is ignored */ }
  });
}

function ensureChannel(): void {
  installStorageListener();
  if (channel || typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel(SETTINGS_CHANNEL);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (!isRecord(event.data) || event.data.type !== "settings-update") return;
    acceptRemote(event.data.settings, event.data.meta ?? { revision: event.data.revision, writerId: event.data.writerId, updatedAt: event.data.updatedAt });
  };
}

export interface RebuildSettingsStore {
  get(): RebuildSettings;
  subscribe(listener: Listener): () => void;
  update(patch: Partial<RebuildSettings> | ((settings: RebuildSettings) => RebuildSettings)): RebuildSettings;
  reset(): RebuildSettings;
  importSettings(raw: string): RebuildSettings;
  exportSettings(): string;
}

export const rebuildSettingsStore: RebuildSettingsStore = {
  get: () => currentSettings,
  subscribe: (listener) => { ensureChannel(); listeners.add(listener); return () => listeners.delete(listener); },
  update: (patch) => {
    const next = typeof patch === "function" ? patch(cloneSettings(currentSettings)) : { ...cloneSettings(currentSettings), ...patch };
    const normalized = normalizeRebuildSettings(next);
    const meta: SettingsMeta = { revision: currentRevision + 1, writerId: instanceWriterId, updatedAt: new Date().toISOString() };
    notify(normalized, true, meta);
    ensureChannel();
    channel?.postMessage({ type: "settings-update", settings: normalized, meta });
    return currentSettings;
  },
  reset: () => rebuildSettingsStore.update(cloneSettings(DEFAULT_REBUILD_SETTINGS)),
  importSettings: (raw) => rebuildSettingsStore.update(parseStoredSettings(raw)),
  exportSettings: () => serializeSettings(currentSettings),
};

export function useRebuildSettings() {
  const settings = useSyncExternalStore(rebuildSettingsStore.subscribe, rebuildSettingsStore.get, () => DEFAULT_REBUILD_SETTINGS);
  const update = useCallback((patch: Partial<RebuildSettings> | ((settings: RebuildSettings) => RebuildSettings)) => rebuildSettingsStore.update(patch), []);
  const reset = useCallback(() => rebuildSettingsStore.reset(), []);
  const importSettings = useCallback((raw: string) => rebuildSettingsStore.importSettings(raw), []);
  const exportSettings = useCallback(() => rebuildSettingsStore.exportSettings(), []);
  return { settings, update, reset, importSettings, exportSettings };
}

