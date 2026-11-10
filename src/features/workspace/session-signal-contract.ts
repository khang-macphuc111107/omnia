import { useSyncExternalStore } from "react";

import {
  filterUnifiedEvents,
  type UnifiedEventFilter,
  type UnifiedEventRecord,
  type UnifiedEventSource,
} from "./unified-event-contract";

/**
 * Renderer-session preferences shared by the signal settings preview and all
 * visible Mission Control signal centers. This intentionally lives outside
 * the durable workspace store: a future native settings bridge can replace
 * the module state without making the current browser preview claim a write.
 */
export type SignalSource = Exclude<UnifiedEventSource, "system">;
export type SignalGrouping = "priority" | "source" | "recent";
export type SignalReviewMode = "manual" | "on-open" | "after-open";
export type SignalVoiceMode = "off" | "queue-preview" | "browser-speech";
export type SignalVoicePreset = "browser-default" | "calm" | "bright";
export type SignalVoiceRate = 0.8 | 1 | 1.2;
export type SignalVoicePriority = "urgent" | "high-or-urgent" | "all";
export type SignalDefaultFilter = Extract<
  UnifiedEventFilter,
  "all" | "unread" | "attention" | "active" | "completed" | "planned"
>;
export type SignalExportFormat = "json" | "markdown";

export interface SignalPreferences {
  readonly enabledSources: Record<SignalSource, boolean>;
  readonly defaultFilter: SignalDefaultFilter;
  readonly grouping: SignalGrouping;
  readonly reviewMode: SignalReviewMode;
  readonly snoozeMinutes: 15 | 30 | 60 | 240;
  readonly compactMode: boolean;
  readonly includeDetails: boolean;
  readonly voiceMode: SignalVoiceMode;
  readonly voicePreset: SignalVoicePreset;
  readonly voiceRate: SignalVoiceRate;
  readonly voicePriority: SignalVoicePriority;
}

export interface SignalPreferencesHistory {
  readonly past: readonly SignalPreferences[];
  readonly present: SignalPreferences;
  readonly future: readonly SignalPreferences[];
}

export const SIGNAL_PREFERENCES_SCHEMA = "omnia.signal-preferences.preview.v1" as const;
export const SIGNAL_PREFERENCES_SCOPE = "renderer-session" as const;
export const SIGNAL_PREFERENCES_BOUNDARY =
  "Renderer-local preference preview only; no durable settings write, notification acknowledgement, scheduler change, native signal subscription, microphone access, or text-to-speech playback was performed.";

export const SIGNAL_SOURCE_OPTIONS: ReadonlyArray<{
  readonly id: SignalSource;
  readonly label: string;
  readonly detail: string;
}> = [
  { id: "chat", label: "Chat", detail: "Unread, draft, queued, streaming, and failed conversations." },
  { id: "project", label: "Project", detail: "Context health, grants, and visible project attention." },
  { id: "background", label: "Background work", detail: "Queue and task projections already visible in the renderer." },
  { id: "notification", label: "Notifications", detail: "Session-local notification and approval previews." },
  { id: "run", label: "Runs", detail: "Replayable run timeline and checkpoint signals." },
];

export const SIGNAL_FILTER_OPTIONS: ReadonlyArray<readonly [SignalDefaultFilter, string]> = [
  ["all", "All signals"],
  ["unread", "Unread first"],
  ["attention", "Needs attention"],
  ["active", "Active work"],
  ["completed", "Completed"],
  ["planned", "Planned / pending"],
];

export const DEFAULT_SIGNAL_PREFERENCES: SignalPreferences = {
  enabledSources: { chat: true, project: true, background: true, notification: true, run: true },
  defaultFilter: "all",
  grouping: "priority",
  reviewMode: "manual",
  snoozeMinutes: 30,
  compactMode: false,
  includeDetails: true,
  voiceMode: "off",
  voicePreset: "browser-default",
  voiceRate: 1,
  voicePriority: "urgent",
};

const SIGNAL_GROUPING_VALUES: readonly SignalGrouping[] = ["priority", "source", "recent"];
const SIGNAL_REVIEW_VALUES: readonly SignalReviewMode[] = ["manual", "on-open", "after-open"];
const SIGNAL_SNOOZE_VALUES: readonly SignalPreferences["snoozeMinutes"][] = [15, 30, 60, 240];
const SIGNAL_VOICE_MODE_VALUES: readonly SignalVoiceMode[] = ["off", "queue-preview", "browser-speech"];
const SIGNAL_VOICE_PRESET_VALUES: readonly SignalVoicePreset[] = ["browser-default", "calm", "bright"];
const SIGNAL_VOICE_RATE_VALUES: readonly SignalVoiceRate[] = [0.8, 1, 1.2];
const SIGNAL_VOICE_PRIORITY_VALUES: readonly SignalVoicePriority[] = ["urgent", "high-or-urgent", "all"];
const SIGNAL_SOURCE_ORDER: readonly UnifiedEventSource[] = ["chat", "project", "background", "notification", "run", "system"];
const SIGNAL_PRIORITY_RANK: Record<UnifiedEventRecord["priority"], number> = {
  low: 1,
  normal: 2,
  high: 3,
  urgent: 4,
};

function clonePreferences(value: SignalPreferences): SignalPreferences {
  return { ...value, enabledSources: { ...value.enabledSources } };
}

export function sameSignalPreferences(left: SignalPreferences, right: SignalPreferences): boolean {
  return left.defaultFilter === right.defaultFilter
    && left.grouping === right.grouping
    && left.reviewMode === right.reviewMode
    && left.snoozeMinutes === right.snoozeMinutes
    && left.compactMode === right.compactMode
    && left.includeDetails === right.includeDetails
    && left.voiceMode === right.voiceMode
    && left.voicePreset === right.voicePreset
    && left.voiceRate === right.voiceRate
    && left.voicePriority === right.voicePriority
    && SIGNAL_SOURCE_OPTIONS.every(({ id }) => left.enabledSources[id] === right.enabledSources[id]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEnabledSources(value: unknown, fallback: SignalPreferences["enabledSources"]): SignalPreferences["enabledSources"] {
  const enabledSources = { ...fallback };
  if (Array.isArray(value)) {
    for (const item of SIGNAL_SOURCE_OPTIONS) enabledSources[item.id] = value.includes(item.id);
  } else if (isRecord(value)) {
    for (const item of SIGNAL_SOURCE_OPTIONS) {
      if (typeof value[item.id] === "boolean") enabledSources[item.id] = value[item.id] as boolean;
    }
  }
  return enabledSources;
}

export function normalizeSignalPreferences(
  value: unknown,
  fallback: SignalPreferences = DEFAULT_SIGNAL_PREFERENCES,
): SignalPreferences {
  const payload = isRecord(value) && isRecord(value.preferences) ? value.preferences : value;
  if (!isRecord(payload)) return clonePreferences(fallback);
  const filterValues = SIGNAL_FILTER_OPTIONS.map(([id]) => id);
  const defaultFilter = filterValues.includes(payload.defaultFilter as SignalDefaultFilter)
    ? payload.defaultFilter as SignalDefaultFilter
    : fallback.defaultFilter;
  const grouping = SIGNAL_GROUPING_VALUES.includes(payload.grouping as SignalGrouping)
    ? payload.grouping as SignalGrouping
    : fallback.grouping;
  const reviewMode = SIGNAL_REVIEW_VALUES.includes(payload.reviewMode as SignalReviewMode)
    ? payload.reviewMode as SignalReviewMode
    : fallback.reviewMode;
  const snooze = Number(payload.snoozeMinutes);
  const voiceRate = Number(payload.voiceRate);
  return {
    enabledSources: normalizeEnabledSources(payload.enabledSources, fallback.enabledSources),
    defaultFilter,
    grouping,
    reviewMode,
    snoozeMinutes: SIGNAL_SNOOZE_VALUES.includes(snooze as SignalPreferences["snoozeMinutes"])
      ? snooze as SignalPreferences["snoozeMinutes"]
      : fallback.snoozeMinutes,
    compactMode: typeof payload.compactMode === "boolean" ? payload.compactMode : fallback.compactMode,
    includeDetails: typeof payload.includeDetails === "boolean" ? payload.includeDetails : fallback.includeDetails,
    voiceMode: SIGNAL_VOICE_MODE_VALUES.includes(payload.voiceMode as SignalVoiceMode)
      ? payload.voiceMode as SignalVoiceMode
      : fallback.voiceMode,
    voicePreset: SIGNAL_VOICE_PRESET_VALUES.includes(payload.voicePreset as SignalVoicePreset)
      ? payload.voicePreset as SignalVoicePreset
      : fallback.voicePreset,
    voiceRate: SIGNAL_VOICE_RATE_VALUES.includes(voiceRate as SignalVoiceRate)
      ? voiceRate as SignalVoiceRate
      : fallback.voiceRate,
    voicePriority: SIGNAL_VOICE_PRIORITY_VALUES.includes(payload.voicePriority as SignalVoicePriority)
      ? payload.voicePriority as SignalVoicePriority
      : fallback.voicePriority,
  };
}

export function serializeSignalPreferences(preferences: SignalPreferences, format: SignalExportFormat): string {
  const enabledSources = SIGNAL_SOURCE_OPTIONS.filter(({ id }) => preferences.enabledSources[id]).map(({ id }) => id);
  const payload = {
    schema: SIGNAL_PREFERENCES_SCHEMA,
    scope: SIGNAL_PREFERENCES_SCOPE,
    preferences: { ...preferences, enabledSources },
    boundary: SIGNAL_PREFERENCES_BOUNDARY,
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia signal preferences preview",
    "",
    `- Default filter: ${SIGNAL_FILTER_OPTIONS.find(([id]) => id === preferences.defaultFilter)?.[1] ?? preferences.defaultFilter}`,
    `- Grouping: ${preferences.grouping}`,
    `- Review mode: ${preferences.reviewMode}`,
    `- Snooze: ${preferences.snoozeMinutes} minutes`,
    `- Enabled sources: ${enabledSources.join(", ") || "none"}`,
    `- Compact mode: ${preferences.compactMode ? "on" : "off"}`,
    `- Include details: ${preferences.includeDetails ? "on" : "off"}`,
    `- Voice mode: ${preferences.voiceMode}`,
    `- Voice preset: ${preferences.voicePreset}`,
    `- Voice rate: ${preferences.voiceRate}x`,
    `- Voice priority: ${preferences.voicePriority}`,
    "",
    "> Renderer-local preview only. No durable settings write or native signal subscription was performed.",
  ].join("\n");
}

export function parseSignalPreferences(
  raw: string,
  format: SignalExportFormat,
  fallback: SignalPreferences = DEFAULT_SIGNAL_PREFERENCES,
): SignalPreferences | null {
  const source = raw.replace(/^\uFEFF/, "").trim();
  if (!source) return null;
  if (format === "json") {
    try {
      const parsed: unknown = JSON.parse(source);
      if (!isRecord(parsed)) return null;
      if ("preferences" in parsed && parsed.preferences !== undefined && !isRecord(parsed.preferences)) return null;
      return normalizeSignalPreferences(parsed, fallback);
    } catch {
      return null;
    }
  }
  const lines = source.split(/\r?\n/);
  const valueFor = (label: string) => lines.find((line) => line.toLowerCase().startsWith(`- ${label.toLowerCase()}:`))?.split(":").slice(1).join(":").trim();
  const filterText = valueFor("Default filter");
  const filterByLabel = SIGNAL_FILTER_OPTIONS.find(([, label]) => label.toLowerCase() === filterText?.toLowerCase())?.[0];
  const groupingText = valueFor("Grouping")?.toLowerCase();
  const reviewText = valueFor("Review mode")?.toLowerCase();
  const snoozeText = Number.parseInt(valueFor("Snooze") ?? "", 10);
  const sourcesText = valueFor("Enabled sources");
  const enabledSources = { ...fallback.enabledSources };
  if (sourcesText) for (const item of SIGNAL_SOURCE_OPTIONS) enabledSources[item.id] = sourcesText.split(",").map((entry) => entry.trim()).includes(item.id);
  const grouping = groupingText === "most recent" ? "recent" : groupingText;
  const reviewMode = reviewText === "mark on open"
    ? "on-open"
    : reviewText === "mark after opening details"
      ? "after-open"
      : reviewText;
  return normalizeSignalPreferences({
    enabledSources,
    defaultFilter: filterByLabel ?? fallback.defaultFilter,
    grouping,
    reviewMode,
    snoozeMinutes: snoozeText,
    compactMode: valueFor("Compact mode")?.toLowerCase() === "on" ? true : valueFor("Compact mode")?.toLowerCase() === "off" ? false : fallback.compactMode,
    includeDetails: valueFor("Include details")?.toLowerCase() === "on" ? true : valueFor("Include details")?.toLowerCase() === "off" ? false : fallback.includeDetails,
    voiceMode: valueFor("Voice mode") as SignalVoiceMode | undefined,
    voicePreset: valueFor("Voice preset") as SignalVoicePreset | undefined,
    voiceRate: Number.parseFloat(valueFor("Voice rate")?.replace(/x$/i, "") ?? "") as SignalVoiceRate,
    voicePriority: valueFor("Voice priority") as SignalVoicePriority | undefined,
  }, fallback);
}

function cloneHistory(value: SignalPreferencesHistory): SignalPreferencesHistory {
  return {
    past: value.past.map(clonePreferences),
    present: clonePreferences(value.present),
    future: value.future.map(clonePreferences),
  };
}

const listeners = new Set<() => void>();
let session: SignalPreferencesHistory = {
  past: [],
  present: clonePreferences(DEFAULT_SIGNAL_PREFERENCES),
  future: [],
};

function publish(next: SignalPreferencesHistory): SignalPreferencesHistory {
  session = cloneHistory(next);
  listeners.forEach((listener) => listener());
  return session;
}

export function getSignalPreferencesSession(): SignalPreferencesHistory {
  return session;
}

export function subscribeSignalPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSignalPreferences(): SignalPreferencesHistory {
  return useSyncExternalStore(subscribeSignalPreferences, getSignalPreferencesSession, getSignalPreferencesSession);
}

export function updateSignalPreferences(patch: Partial<SignalPreferences>): SignalPreferences {
  const next = normalizeSignalPreferences({ ...session.present, ...patch }, session.present);
  if (sameSignalPreferences(next, session.present)) return session.present;
  publish({
    past: [...session.past, clonePreferences(session.present)].slice(-50),
    present: next,
    future: [],
  });
  return next;
}

export function replaceSignalPreferences(value: unknown): SignalPreferences {
  const next = normalizeSignalPreferences(value, session.present);
  if (sameSignalPreferences(next, session.present)) return session.present;
  publish({
    past: [...session.past, clonePreferences(session.present)].slice(-50),
    present: next,
    future: [],
  });
  return next;
}

export function undoSignalPreferences(): SignalPreferences {
  const previous = session.past.at(-1);
  if (!previous) return session.present;
  publish({
    past: session.past.slice(0, -1),
    present: previous,
    future: [clonePreferences(session.present), ...session.future],
  });
  return session.present;
}

export function redoSignalPreferences(): SignalPreferences {
  const next = session.future[0];
  if (!next) return session.present;
  publish({
    past: [...session.past, clonePreferences(session.present)].slice(-50),
    present: next,
    future: session.future.slice(1),
  });
  return session.present;
}

export function resetSignalPreferences(): SignalPreferences {
  if (sameSignalPreferences(session.present, DEFAULT_SIGNAL_PREFERENCES)) return session.present;
  publish({
    past: [...session.past, clonePreferences(session.present)].slice(-50),
    present: DEFAULT_SIGNAL_PREFERENCES,
    future: [],
  });
  return session.present;
}

/** Test/preview helper; never persists anything outside this module. */
export function resetSignalPreferencesSession(): void {
  session = {
    past: [],
    present: clonePreferences(DEFAULT_SIGNAL_PREFERENCES),
    future: [],
  };
  listeners.forEach((listener) => listener());
}

function occurredAtMs(event: UnifiedEventRecord): number {
  const parsed = Date.parse(event.occurredAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareByPriority(left: UnifiedEventRecord, right: UnifiedEventRecord): number {
  return SIGNAL_PRIORITY_RANK[right.priority] - SIGNAL_PRIORITY_RANK[left.priority]
    || occurredAtMs(right) - occurredAtMs(left)
    || left.id.localeCompare(right.id);
}

function compareBySource(left: UnifiedEventRecord, right: UnifiedEventRecord): number {
  return SIGNAL_SOURCE_ORDER.indexOf(left.source) - SIGNAL_SOURCE_ORDER.indexOf(right.source)
    || compareByPriority(left, right);
}

function compareByRecent(left: UnifiedEventRecord, right: UnifiedEventRecord): number {
  return occurredAtMs(right) - occurredAtMs(left)
    || compareByPriority(left, right);
}

/** Applies renderer-session source visibility and ordering to a signal set. */
export function applySignalPreferencesToEvents(
  events: readonly UnifiedEventRecord[],
  preferences: SignalPreferences,
): UnifiedEventRecord[] {
  const visible = events.filter((event) => event.source === "system" || preferences.enabledSources[event.source]);
  const grouped = preferences.grouping === "source"
    ? [...visible].sort(compareBySource)
    : preferences.grouping === "recent"
      ? [...visible].sort(compareByRecent)
      : [...visible].sort(compareByPriority);
  return filterUnifiedEvents(grouped, "all");
}
