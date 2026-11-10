/**
 * Runtime controls shared by the agent shell and future native bridges.
 *
 * Settings are deliberately plain data: a renderer can hot reload them while
 * a native session keeps its own permission boundary.  The normalizer is the
 * single place that prevents an edited JSON file or localStorage entry from
 * creating an unsafe/unbounded request.
 */

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Retry policy controls are kept as data so the renderer can expose a
 * bounded, inspectable draft while the native provider gateway remains the
 * authority for whether a retry is safe.  The shape follows the retry policy
 * schema used by the native/observability contracts.
 */
export const RETRY_JITTERS = ["none", "full", "equal", "decorrelated"] as const;
export type RetryJitter = (typeof RETRY_JITTERS)[number];

export const RETRY_ACTIONS = ["stop", "ask_user", "refresh_auth", "fallback", "retry", "repair", "outcome_unknown"] as const;
export type RetryAction = (typeof RETRY_ACTIONS)[number];

export interface OmniaRetryStatusRule {
  status: number;
  action: RetryAction;
  retryable?: boolean;
  requiresIdempotencyEvidence?: boolean;
  notes?: string;
}

export interface OmniaRetryPolicy {
  schemaVersion: 1;
  policyId: string;
  /** Retry incomplete sessions even when the error is not classified yet. */
  retryOnAnyError: boolean;
  /** Delay before the first retry, in seconds. */
  retryDelaySeconds: number;
  /** Multiplier applied by a native scheduler to subsequent delays. */
  retryMultiplier: number;
  maxElapsedSeconds: number;
  maxAttempts: number | null;
  scheduleSeconds: number[];
  maxSingleDelaySeconds: number;
  jitter: RetryJitter;
  honorRetryAfter: boolean;
  allowProviderFallback: boolean;
  allowModelFallback: boolean;
  allowPromptRepair: boolean;
  /** Repairs must be presented as a semantic diff before dispatch. */
  requireSemanticDiffForRepair: true;
  statusRules: OmniaRetryStatusRule[];
}

export interface OmniaRuntimeSettings {
  schemaVersion: 1;
  contextWindowTokens: number;
  toolOutputLimitChars: number;
  planIterations: number;
  autoPlan: boolean;
  autoResearch: boolean;
  webSearch: "smart" | "always" | "off";
  browser: { enabled: boolean; headless: boolean; domDepth: number; screenshotOnAction: boolean };
  computer: { enabled: boolean; headless: boolean; screenshotOnAction: boolean; ocrOnDemand: boolean };
  telemetry: { enabled: boolean; retainDays: number; includePromptText: boolean };
  defaultEffort: ReasoningEffort;
  retryPolicy: OmniaRetryPolicy;
}

/** User-facing default: retry every five seconds with no attempt cap. */
export const DEFAULT_RETRY_SCHEDULE_SECONDS = [5] as const;

const DEFAULT_RETRY_STATUS_RULES: OmniaRetryStatusRule[] = [
  { status: 408, action: "retry", retryable: true, requiresIdempotencyEvidence: true },
  { status: 409, action: "retry", retryable: true },
  { status: 425, action: "retry", retryable: true },
  { status: 429, action: "retry", retryable: true },
  { status: 500, action: "retry", retryable: true },
  { status: 502, action: "retry", retryable: true },
  { status: 503, action: "retry", retryable: true },
  { status: 504, action: "retry", retryable: true },
];

export const DEFAULT_RUNTIME_SETTINGS: OmniaRuntimeSettings = {
  schemaVersion: 1,
  contextWindowTokens: 200_000,
  toolOutputLimitChars: 10_000,
  planIterations: 3,
  autoPlan: true,
  autoResearch: true,
  webSearch: "smart",
  browser: { enabled: false, headless: true, domDepth: 4, screenshotOnAction: false },
  computer: { enabled: false, headless: true, screenshotOnAction: false, ocrOnDemand: true },
  telemetry: { enabled: true, retainDays: 30, includePromptText: false },
  defaultEffort: "medium",
  retryPolicy: {
    schemaVersion: 1,
    policyId: "default-retry-v1",
    retryOnAnyError: true,
    retryDelaySeconds: 5,
    retryMultiplier: 1,
    // Zero means no elapsed-time cap; maxAttempts is also unlimited by
    // default so an incomplete session can keep retrying until it finishes.
    maxElapsedSeconds: 0,
    maxAttempts: null,
    scheduleSeconds: [...DEFAULT_RETRY_SCHEDULE_SECONDS],
    maxSingleDelaySeconds: 900,
    // Keep the requested five-second cadence deterministic by default. A
    // native route may still add provider-mandated jitter when required.
    jitter: "none",
    honorRetryAfter: true,
    allowProviderFallback: true,
    allowModelFallback: true,
    allowPromptRepair: true,
    requireSemanticDiffForRepair: true,
    statusRules: DEFAULT_RETRY_STATUS_RULES.map((rule) => ({ ...rule })),
  },
};

export const RUNTIME_SETTINGS_STORAGE_KEY = "omnia-runtime-settings-v1";

export function readRuntimeSettings(storage: Storage | null = typeof window === "undefined" ? null : window.localStorage): OmniaRuntimeSettings {
  if (!storage) return DEFAULT_RUNTIME_SETTINGS;
  try {
    const raw = storage.getItem(RUNTIME_SETTINGS_STORAGE_KEY);
    return raw ? normalizeRuntimeSettings(JSON.parse(raw)) : DEFAULT_RUNTIME_SETTINGS;
  } catch {
    return DEFAULT_RUNTIME_SETTINGS;
  }
}

export function writeRuntimeSettings(settings: unknown, storage: Storage | null = typeof window === "undefined" ? null : window.localStorage): OmniaRuntimeSettings {
  const normalized = normalizeRuntimeSettings(settings);
  try { storage?.setItem(RUNTIME_SETTINGS_STORAGE_KEY, JSON.stringify(normalized)); } catch { /* best effort; native settings remain authoritative */ }
  return normalized;
}

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
};

const bool = (value: unknown, fallback: boolean): boolean => typeof value === "boolean" ? value : fallback;

function normalizeRetryPolicy(value: unknown): OmniaRetryPolicy {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawRules = Array.isArray(raw.statusRules) ? raw.statusRules : [];
  const statusRules: OmniaRetryStatusRule[] = [];
  for (const candidate of rawRules.slice(0, 64)) {
    if (!candidate || typeof candidate !== "object") continue;
    const rule = candidate as Record<string, unknown>;
    const parsedStatus = typeof rule.status === "number" ? rule.status : Number(rule.status);
    if (!Number.isSafeInteger(parsedStatus) || parsedStatus < 100 || parsedStatus > 599 || typeof rule.action !== "string" || !RETRY_ACTIONS.includes(rule.action as RetryAction)) continue;
    const normalized: OmniaRetryStatusRule = {
      status: parsedStatus,
      action: rule.action as RetryAction,
      ...(typeof rule.retryable === "boolean" ? { retryable: rule.retryable } : {}),
      ...(typeof rule.requiresIdempotencyEvidence === "boolean" ? { requiresIdempotencyEvidence: rule.requiresIdempotencyEvidence } : {}),
      ...(typeof rule.notes === "string" && rule.notes.length <= 2048 ? { notes: rule.notes } : {}),
    };
    statusRules.push(normalized);
  }
  const rawRetryDelay = raw.retryDelaySeconds ?? raw.baseDelaySeconds ?? raw.initialDelaySeconds;
  const parsedRetryDelay = rawRetryDelay === null || rawRetryDelay === undefined || rawRetryDelay === ""
    ? Number.NaN
    : typeof rawRetryDelay === "number" ? rawRetryDelay : Number(rawRetryDelay);
  const retryDelaySeconds = Number.isFinite(parsedRetryDelay)
    ? clampInt(parsedRetryDelay, DEFAULT_RUNTIME_SETTINGS.retryPolicy.retryDelaySeconds, 1, 900)
    : DEFAULT_RUNTIME_SETTINGS.retryPolicy.retryDelaySeconds;
  const retryMultiplierRaw = raw.retryMultiplier === null || raw.retryMultiplier === undefined || raw.retryMultiplier === ""
    ? Number.NaN
    : typeof raw.retryMultiplier === "number" ? raw.retryMultiplier : Number(raw.retryMultiplier);
  const retryMultiplier = Number.isFinite(retryMultiplierRaw)
    ? Math.min(10, Math.max(0.1, Math.round(retryMultiplierRaw * 10) / 10))
    : DEFAULT_RUNTIME_SETTINGS.retryPolicy.retryMultiplier;
  const schedule = Array.isArray(raw.scheduleSeconds)
    ? raw.scheduleSeconds
      .map((entry) => clampInt(entry, -1, 0, 900))
      .filter((entry) => entry >= 0)
      .slice(0, 32)
    : [];
  const maxSingleDelaySeconds = clampInt(raw.maxSingleDelaySeconds, DEFAULT_RUNTIME_SETTINGS.retryPolicy.maxSingleDelaySeconds, 1, 900);
  const boundedSchedule = (schedule.length > 0 ? schedule : [retryDelaySeconds])
    .map((entry) => Math.min(maxSingleDelaySeconds, entry));
  const rawAttempts = raw.maxAttempts;
  const parsedAttempts = typeof rawAttempts === "number"
    ? rawAttempts
    : typeof rawAttempts === "string" && rawAttempts.trim() !== ""
      ? Number(rawAttempts)
      : Number.NaN;
  const maxAttempts = rawAttempts === null || rawAttempts === undefined || rawAttempts === ""
    ? null
    : Number.isFinite(parsedAttempts)
      ? clampInt(parsedAttempts, 1, 1, 20)
      : DEFAULT_RUNTIME_SETTINGS.retryPolicy.maxAttempts;
  const policyId = typeof raw.policyId === "string" && raw.policyId.trim().length > 0
    ? raw.policyId.trim().slice(0, 120)
    : DEFAULT_RUNTIME_SETTINGS.retryPolicy.policyId;
  return {
    schemaVersion: 1,
    policyId,
    retryOnAnyError: bool(raw.retryOnAnyError, DEFAULT_RUNTIME_SETTINGS.retryPolicy.retryOnAnyError),
    retryDelaySeconds,
    retryMultiplier,
    maxElapsedSeconds: clampInt(raw.maxElapsedSeconds, DEFAULT_RUNTIME_SETTINGS.retryPolicy.maxElapsedSeconds, 0, 7 * 24 * 60 * 60),
    maxAttempts,
    scheduleSeconds: boundedSchedule,
    maxSingleDelaySeconds,
    jitter: typeof raw.jitter === "string" && RETRY_JITTERS.includes(raw.jitter as RetryJitter)
      ? raw.jitter as RetryJitter
      : DEFAULT_RUNTIME_SETTINGS.retryPolicy.jitter,
    honorRetryAfter: bool(raw.honorRetryAfter, DEFAULT_RUNTIME_SETTINGS.retryPolicy.honorRetryAfter),
    allowProviderFallback: bool(raw.allowProviderFallback, DEFAULT_RUNTIME_SETTINGS.retryPolicy.allowProviderFallback),
    allowModelFallback: bool(raw.allowModelFallback, DEFAULT_RUNTIME_SETTINGS.retryPolicy.allowModelFallback),
    allowPromptRepair: bool(raw.allowPromptRepair, DEFAULT_RUNTIME_SETTINGS.retryPolicy.allowPromptRepair),
    requireSemanticDiffForRepair: true,
    statusRules: statusRules.length > 0 ? statusRules : DEFAULT_RETRY_STATUS_RULES.map((rule) => ({ ...rule })),
  };
}

export function normalizeRuntimeSettings(value: unknown): OmniaRuntimeSettings {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const browser = raw.browser && typeof raw.browser === "object" ? raw.browser as Record<string, unknown> : {};
  const computer = raw.computer && typeof raw.computer === "object" ? raw.computer as Record<string, unknown> : {};
  const telemetry = raw.telemetry && typeof raw.telemetry === "object" ? raw.telemetry as Record<string, unknown> : {};
  // `retry` was used by an early renderer draft; accepting it on read keeps
  // those localStorage snapshots forward-compatible while writes use the
  // schema-aligned `retryPolicy` key.
  const retryPolicy = normalizeRetryPolicy(raw.retryPolicy ?? raw.retry);
  const effort = typeof raw.defaultEffort === "string" && REASONING_EFFORTS.includes(raw.defaultEffort as ReasoningEffort)
    ? raw.defaultEffort as ReasoningEffort : DEFAULT_RUNTIME_SETTINGS.defaultEffort;
  const webSearch = raw.webSearch === "always" || raw.webSearch === "off" || raw.webSearch === "smart" ? raw.webSearch : DEFAULT_RUNTIME_SETTINGS.webSearch;
  return {
    schemaVersion: 1,
    contextWindowTokens: clampInt(raw.contextWindowTokens, DEFAULT_RUNTIME_SETTINGS.contextWindowTokens, 8_192, 2_000_000),
    toolOutputLimitChars: clampInt(raw.toolOutputLimitChars, DEFAULT_RUNTIME_SETTINGS.toolOutputLimitChars, 1_000, 200_000),
    planIterations: clampInt(raw.planIterations, DEFAULT_RUNTIME_SETTINGS.planIterations, 0, 10),
    autoPlan: bool(raw.autoPlan, DEFAULT_RUNTIME_SETTINGS.autoPlan),
    autoResearch: bool(raw.autoResearch, DEFAULT_RUNTIME_SETTINGS.autoResearch),
    webSearch,
    browser: {
      enabled: bool(browser.enabled, DEFAULT_RUNTIME_SETTINGS.browser.enabled),
      headless: bool(browser.headless, DEFAULT_RUNTIME_SETTINGS.browser.headless),
      domDepth: clampInt(browser.domDepth, DEFAULT_RUNTIME_SETTINGS.browser.domDepth, 1, 12),
      screenshotOnAction: bool(browser.screenshotOnAction, DEFAULT_RUNTIME_SETTINGS.browser.screenshotOnAction),
    },
    computer: {
      enabled: bool(computer.enabled, DEFAULT_RUNTIME_SETTINGS.computer.enabled),
      headless: bool(computer.headless, DEFAULT_RUNTIME_SETTINGS.computer.headless),
      screenshotOnAction: bool(computer.screenshotOnAction, DEFAULT_RUNTIME_SETTINGS.computer.screenshotOnAction),
      ocrOnDemand: bool(computer.ocrOnDemand, DEFAULT_RUNTIME_SETTINGS.computer.ocrOnDemand),
    },
    telemetry: {
      enabled: bool(telemetry.enabled, DEFAULT_RUNTIME_SETTINGS.telemetry.enabled),
      retainDays: clampInt(telemetry.retainDays, DEFAULT_RUNTIME_SETTINGS.telemetry.retainDays, 1, 3650),
      includePromptText: bool(telemetry.includePromptText, DEFAULT_RUNTIME_SETTINGS.telemetry.includePromptText),
    },
    defaultEffort: effort,
    retryPolicy,
  };
}

export type RuntimeSettingsListener = (settings: OmniaRuntimeSettings) => void;

export function createRuntimeSettingsController(initial: unknown = DEFAULT_RUNTIME_SETTINGS) {
  let settings = normalizeRuntimeSettings(initial);
  const listeners = new Set<RuntimeSettingsListener>();
  return {
    get: () => settings,
    update(patch: unknown): OmniaRuntimeSettings {
      const next = normalizeRuntimeSettings({ ...settings, ...(patch && typeof patch === "object" ? patch : {}) });
      settings = next;
      listeners.forEach((listener) => listener(next));
      return next;
    },
    replace(next: unknown): OmniaRuntimeSettings {
      settings = normalizeRuntimeSettings(next);
      listeners.forEach((listener) => listener(settings));
      return settings;
    },
    subscribe(listener: RuntimeSettingsListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
