import { redactDiagnosticText } from "./diagnostics-session-contract";
import type { RunTimelineEventView } from "./evidence-types";
import type { BackgroundWorkItem } from "./background-work-projection";
import type { NotificationAction, NotificationItem } from "./notification-center-contract";
import type { ProjectActivityEvent } from "./project-activity-timeline";

/**
 * A small, source-neutral event vocabulary shared by the Chat, Project,
 * background-work, run, and notification previews.
 *
 * This is deliberately a renderer contract. It gives future surfaces one
 * shape to filter, group, and export, while keeping the native event journal,
 * scheduler, provider dispatch, and durable acknowledgements out of scope.
 */
export const UNIFIED_EVENT_SCHEMA = "omnia.unified-event.preview.v1" as const;
export const UNIFIED_EVENT_VERSION = 1 as const;
export const UNIFIED_EVENT_SCOPE = "renderer-session" as const;
export const UNIFIED_EVENT_MAX_BYTES = 512 * 1024;
/** Keep renderer projections bounded even when a caller hands us a malformed
 * or unexpectedly large in-memory collection. The byte limit remains the
 * portable-export guard; this count protects direct projection callers. */
export const UNIFIED_EVENT_MAX_EVENTS = 2_000;
export const UNIFIED_EVENT_MAX_OCCURRENCES = 1_000_000;
export const UNIFIED_EVENT_BOUNDARY =
  "Renderer-local unified event projection only. It does not replace the native run journal, create durable activity history, dispatch providers, schedule work, or acknowledge notifications.";

export type UnifiedEventSource =
  | "chat"
  | "project"
  | "background"
  | "notification"
  | "run"
  | "system";

export type UnifiedEventKind =
  | "activity"
  | "attention"
  | "approval"
  | "completion"
  | "failure"
  | "indexing"
  | "progress"
  | "info";

export type UnifiedEventState =
  | "planned"
  | "queued"
  | "running"
  | "waiting"
  | "attention"
  | "completed"
  | "cancelled"
  | "failed"
  | "info";

export type UnifiedEventDurability = "renderer-session" | "native-projection" | "planned";
export type UnifiedEventPriority = "urgent" | "high" | "normal" | "low";
export type UnifiedEventVisibility = "unread" | "read" | "snoozed" | "dismissed";
export type UnifiedEventFormat = "json" | "markdown";

export type UnifiedEventFilter =
  | "all"
  | "unread"
  | "attention"
  | "active"
  | "completed"
  | "failures"
  | "planned"
  | "chat"
  | "project"
  | "background"
  | "notification"
  | "run";

export interface UnifiedEventAction {
  readonly id: string;
  readonly label: string;
  readonly kind: NotificationAction["kind"] | "inspect" | "open-project";
  readonly disposition: NotificationAction["disposition"];
}

export interface UnifiedEventRecord {
  readonly id: string;
  readonly dedupeKey: string;
  readonly source: UnifiedEventSource;
  readonly kind: UnifiedEventKind;
  readonly state: UnifiedEventState;
  readonly visibility: UnifiedEventVisibility;
  readonly durability: UnifiedEventDurability;
  readonly priority: UnifiedEventPriority;
  readonly title: string;
  readonly summary: string;
  readonly detail: string | null;
  readonly occurredAt: string;
  readonly sourceLabel: string;
  readonly sourceType: string | null;
  readonly projectId: string | null;
  readonly conversationId: string | null;
  readonly runId: string | null;
  readonly parentEventId: string | null;
  readonly requiresInput: boolean;
  readonly actions: readonly UnifiedEventAction[];
  readonly occurrenceCount: number;
}

export interface UnifiedEventCounts {
  readonly total: number;
  readonly unread: number;
  readonly attention: number;
  readonly active: number;
  readonly completed: number;
  readonly failures: number;
  readonly planned: number;
  readonly nativeProjection: number;
  readonly requiresInput: number;
}

export interface UnifiedEventProjection {
  readonly schema: typeof UNIFIED_EVENT_SCHEMA;
  readonly version: typeof UNIFIED_EVENT_VERSION;
  readonly scope: typeof UNIFIED_EVENT_SCOPE;
  readonly generatedAt: string;
  readonly selectedFilter: UnifiedEventFilter;
  readonly events: readonly UnifiedEventRecord[];
  readonly counts: UnifiedEventCounts;
  readonly boundary: {
    readonly rendererOnly: true;
    readonly noDurableWrite: true;
    readonly noProviderRequest: true;
    readonly noScheduler: true;
    readonly noNotificationAck: true;
  };
}

export interface UnifiedEventProjectionInput {
  readonly events: readonly UnifiedEventRecord[];
  readonly generatedAt?: string;
  readonly selectedFilter?: UnifiedEventFilter;
}

export interface UnifiedEventSourceInput {
  readonly projectActivity?: readonly ProjectActivityEvent[];
  readonly notifications?: readonly NotificationItem[];
  readonly backgroundWork?: readonly BackgroundWorkItem[];
  readonly runTimeline?: readonly RunTimelineEventView[];
}

const SOURCE_VALUES: readonly UnifiedEventSource[] = [
  "chat",
  "project",
  "background",
  "notification",
  "run",
  "system",
];
const KIND_VALUES: readonly UnifiedEventKind[] = [
  "activity",
  "attention",
  "approval",
  "completion",
  "failure",
  "indexing",
  "progress",
  "info",
];
const STATE_VALUES: readonly UnifiedEventState[] = [
  "planned",
  "queued",
  "running",
  "waiting",
  "attention",
  "completed",
  "cancelled",
  "failed",
  "info",
];
const DURABILITY_VALUES: readonly UnifiedEventDurability[] = [
  "renderer-session",
  "native-projection",
  "planned",
];
const PRIORITY_VALUES: readonly UnifiedEventPriority[] = ["urgent", "high", "normal", "low"];
const VISIBILITY_VALUES: readonly UnifiedEventVisibility[] = ["unread", "read", "snoozed", "dismissed"];
const FILTER_VALUES: readonly UnifiedEventFilter[] = [
  "all",
  "unread",
  "attention",
  "active",
  "completed",
  "failures",
  "planned",
  "chat",
  "project",
  "background",
  "notification",
  "run",
];
const ACTION_DISPOSITION_VALUES: readonly NotificationAction["disposition"][] = [
  "available",
  "planned",
  "unavailable",
];
const ACTION_KIND_VALUES: readonly UnifiedEventAction["kind"][] = [
  "open-chat",
  "open-run",
  "review",
  "retry",
  "dismiss",
  "snooze",
  "copy",
  "inspect",
  "open-project",
];
const DURABILITY_RANK: Record<UnifiedEventDurability, number> = {
  planned: 0,
  "renderer-session": 1,
  "native-projection": 2,
};
const PRIORITY_RANK: Record<UnifiedEventPriority, number> = {
  low: 1,
  normal: 2,
  high: 3,
  urgent: 4,
};

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;
}

function safeText(value: unknown, maxLength: number): string {
  return redactDiagnosticText(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safeNullableText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  const text = safeText(value, maxLength);
  return text || null;
}

function safeOccurredAt(value: unknown): string {
  const text = safeText(value, 120);
  if (!text) return "Unknown time";
  const parsed = Date.parse(text);
  // Project activity deliberately uses labels such as "Current selection" or
  // "Planned next". Preserve those labels instead of manufacturing a Unix
  // epoch timestamp that would look like durable chronology.
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}

function safeGeneratedAt(value: unknown): string {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}

function safeOccurrenceCount(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(UNIFIED_EVENT_MAX_OCCURRENCES, Math.max(1, Math.floor(numeric)));
}

function safeAction(value: unknown): UnifiedEventAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  const id = safeText(action.id, 120);
  const label = safeText(action.label, 160);
  if (!id || !label || !ACTION_KIND_VALUES.includes(action.kind as UnifiedEventAction["kind"])) return null;
  return {
    id,
    label,
    kind: action.kind as UnifiedEventAction["kind"],
    disposition: enumValue(action.disposition, ACTION_DISPOSITION_VALUES, "unavailable"),
  };
}

function normalizeEvent(value: unknown): UnifiedEventRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const id = safeText(event.id, 180);
  if (!id) return null;
  const rawActions = Array.isArray(event.actions) ? event.actions : [];
  const actions = rawActions.map(safeAction).filter((action): action is UnifiedEventAction => action !== null).slice(0, 12);
  const dedupeKey = safeText(event.dedupeKey, 220) || id;
  return {
    id,
    dedupeKey,
    source: enumValue(event.source, SOURCE_VALUES, "system"),
    kind: enumValue(event.kind, KIND_VALUES, "info"),
    state: enumValue(event.state, STATE_VALUES, "info"),
    visibility: enumValue(event.visibility, VISIBILITY_VALUES, "read"),
    durability: enumValue(event.durability, DURABILITY_VALUES, "renderer-session"),
    priority: enumValue(event.priority, PRIORITY_VALUES, "normal"),
    title: safeText(event.title, 240),
    summary: safeText(event.summary, 800),
    detail: safeNullableText(event.detail, 2_000),
    occurredAt: safeOccurredAt(event.occurredAt),
    sourceLabel: safeText(event.sourceLabel, 180),
    sourceType: safeNullableText(event.sourceType, 120),
    projectId: safeNullableText(event.projectId, 180),
    conversationId: safeNullableText(event.conversationId, 180),
    runId: safeNullableText(event.runId, 180),
    parentEventId: safeNullableText(event.parentEventId, 180),
    requiresInput: event.requiresInput === true,
    actions,
    occurrenceCount: safeOccurrenceCount(event.occurrenceCount),
  };
}

function occurredAtMs(event: UnifiedEventRecord): number {
  const parsed = Date.parse(event.occurredAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareEvents(left: UnifiedEventRecord, right: UnifiedEventRecord): number {
  return (
    PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority] ||
    occurredAtMs(right) - occurredAtMs(left) ||
    left.id.localeCompare(right.id)
  );
}

function preferEvent(left: UnifiedEventRecord, right: UnifiedEventRecord): UnifiedEventRecord {
  const leftRank = DURABILITY_RANK[left.durability];
  const rightRank = DURABILITY_RANK[right.durability];
  if (leftRank !== rightRank) return leftRank > rightRank ? left : right;
  return compareEvents(left, right) <= 0 ? left : right;
}

export function dedupeUnifiedEvents(events: readonly UnifiedEventRecord[]): UnifiedEventRecord[] {
  const byKey = new Map<string, UnifiedEventRecord>();
  for (const raw of events.slice(0, UNIFIED_EVENT_MAX_EVENTS)) {
    const candidate = normalizeEvent(raw);
    if (!candidate) continue;
    const key = candidate.dedupeKey || candidate.id;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }
    const preferred = preferEvent(candidate, existing);
    byKey.set(key, {
      ...preferred,
      occurrenceCount: Math.min(
        UNIFIED_EVENT_MAX_OCCURRENCES,
        (existing.occurrenceCount || 1) + (candidate.occurrenceCount || 1),
      ),
      requiresInput: existing.requiresInput || candidate.requiresInput,
      visibility: existing.visibility === "unread" || candidate.visibility === "unread" ? "unread" : preferred.visibility,
    });
  }
  return Array.from(byKey.values()).sort(compareEvents).slice(0, UNIFIED_EVENT_MAX_EVENTS);
}

function mapProjectKind(kind: ProjectActivityEvent["kind"]): UnifiedEventKind {
  return kind === "context" ? "progress" : "activity";
}

export function unifiedEventFromProjectActivity(event: ProjectActivityEvent): UnifiedEventRecord {
  const planned = event.status === "planned";
  return {
    id: event.id,
    dedupeKey: `project:${event.id}`,
    source: event.kind === "chat" ? "chat" : "project",
    kind: mapProjectKind(event.kind),
    state: planned ? "planned" : "info",
    visibility: "read",
    durability: planned ? "planned" : "renderer-session",
    priority: planned ? "low" : "normal",
    title: event.title,
    summary: event.detail,
    detail: event.detail,
    occurredAt: safeOccurredAt(event.occurredAt),
    sourceLabel: event.sourceLabel,
    sourceType: event.type,
    projectId: event.relatedId,
    conversationId: event.kind === "chat" ? event.relatedId : null,
    runId: null,
    parentEventId: null,
    requiresInput: false,
    actions: [{ id: `${event.id}:inspect`, label: "Inspect", kind: "inspect", disposition: "available" }],
    occurrenceCount: 1,
  };
}

function notificationState(item: NotificationItem): UnifiedEventState {
  if (item.kind === "approval" || item.kind === "attention") return "attention";
  if (item.kind === "completion") return "completed";
  if (item.kind === "failure") return "failed";
  if (item.kind === "indexing") return "running";
  return "info";
}

function notificationKind(item: NotificationItem): UnifiedEventKind {
  return item.kind === "attention" ? "attention" : item.kind;
}

export function unifiedEventFromNotification(item: NotificationItem): UnifiedEventRecord {
  return {
    id: item.id,
    dedupeKey: `notification:${item.dedupeKey || item.id}`,
    source: "notification",
    kind: notificationKind(item),
    state: notificationState(item),
    visibility: item.status,
    durability: "renderer-session",
    priority: item.priority,
    title: item.title,
    summary: item.summary,
    detail: item.summary,
    occurredAt: item.occurredAt,
    sourceLabel: item.sourceLabel,
    sourceType: item.sourceType ?? null,
    projectId: item.projectId ?? null,
    conversationId: item.conversationId ?? null,
    runId: item.runId ?? null,
    parentEventId: null,
    requiresInput: item.requiresInput,
    actions: item.actions,
    occurrenceCount: item.occurrenceCount ?? 1,
  };
}

function backgroundKind(item: BackgroundWorkItem): UnifiedEventKind {
  if (item.state === "attention") return "attention";
  if (item.state === "completed") return "completion";
  if (item.state === "cancelled") return "info";
  return item.state === "queued" || item.state === "running" ? "progress" : "activity";
}

function backgroundState(item: BackgroundWorkItem): UnifiedEventState {
  if (item.state === "attention") return "attention";
  if (item.state === "completed") return "completed";
  if (item.state === "cancelled") return "cancelled";
  return item.state;
}

export function unifiedEventFromBackgroundWork(item: BackgroundWorkItem): UnifiedEventRecord {
  const attention = item.attention || item.state === "attention";
  return {
    id: item.id,
    dedupeKey: `background:${item.id}`,
    source: "background",
    kind: backgroundKind(item),
    state: backgroundState(item),
    visibility: attention ? "unread" : "read",
    durability: item.durability,
    priority: attention ? "urgent" : item.state === "running" ? "high" : "normal",
    title: item.title,
    summary: item.subtitle,
    detail: item.detail,
    occurredAt: item.updatedAt,
    sourceLabel: "Background work",
    sourceType: item.kind,
    projectId: null,
    conversationId: item.conversationId,
    runId: item.runId,
    parentEventId: null,
    requiresInput: attention,
    actions: item.actions.map((kind) => ({ id: `${item.id}:${kind}`, label: kind === "open-chat" ? "Open chat" : "Inspect", kind: kind === "open-chat" ? "open-chat" : "inspect", disposition: "available" })),
    occurrenceCount: 1,
  };
}

function runKind(event: RunTimelineEventView): UnifiedEventKind {
  if (event.status === "failed") return "failure";
  if (event.status === "warning") return "attention";
  if (event.status === "complete") return "completion";
  if (event.stage === "retrieval") return "indexing";
  return "progress";
}

function runState(event: RunTimelineEventView): UnifiedEventState {
  if (event.status === "failed") return "failed";
  if (event.status === "warning") return "attention";
  if (event.status === "complete") return "completed";
  if (event.status === "stopped") return "cancelled";
  if (event.status === "pending") return "queued";
  return "running";
}

export function unifiedEventFromRunTimeline(event: RunTimelineEventView): UnifiedEventRecord {
  const needsAttention = event.status === "failed" || event.status === "warning";
  return {
    id: event.id,
    dedupeKey: `run:${event.runId}:${event.id}`,
    source: "run",
    kind: runKind(event),
    state: runState(event),
    visibility: needsAttention ? "unread" : "read",
    durability: "native-projection",
    priority: needsAttention ? "high" : "normal",
    title: event.summary,
    summary: event.detail ?? event.summary,
    detail: event.detail,
    occurredAt: event.endedAt ?? event.startedAt,
    sourceLabel: event.source,
    sourceType: event.type,
    projectId: null,
    conversationId: null,
    runId: event.runId,
    parentEventId: event.parentEventId,
    requiresInput: needsAttention,
    actions: [{ id: `${event.id}:inspect`, label: "Inspect run", kind: "inspect", disposition: "available" }],
    occurrenceCount: 1,
  };
}

export function unifiedEventsFromSources(input: UnifiedEventSourceInput): UnifiedEventRecord[] {
  return dedupeUnifiedEvents([
    ...(Array.isArray(input.projectActivity) ? input.projectActivity : []).map(unifiedEventFromProjectActivity),
    ...(Array.isArray(input.notifications) ? input.notifications : []).map(unifiedEventFromNotification),
    ...(Array.isArray(input.backgroundWork) ? input.backgroundWork : []).map(unifiedEventFromBackgroundWork),
    ...(Array.isArray(input.runTimeline) ? input.runTimeline : []).map(unifiedEventFromRunTimeline),
  ]);
}

function buildCounts(events: readonly UnifiedEventRecord[]): UnifiedEventCounts {
  return {
    total: events.length,
    unread: events.filter((event) => event.visibility === "unread").length,
    attention: events.filter((event) => event.kind === "attention" || event.requiresInput || event.state === "attention").length,
    active: events.filter((event) => event.state === "queued" || event.state === "running" || event.state === "waiting").length,
    completed: events.filter((event) => event.state === "completed").length,
    failures: events.filter((event) => event.state === "failed").length,
    planned: events.filter((event) => event.state === "planned" || event.durability === "planned").length,
    nativeProjection: events.filter((event) => event.durability === "native-projection").length,
    requiresInput: events.filter((event) => event.requiresInput).length,
  };
}

export function filterUnifiedEvents(
  events: readonly UnifiedEventRecord[],
  filter: UnifiedEventFilter,
): UnifiedEventRecord[] {
  switch (filter) {
    case "unread": return events.filter((event) => event.visibility === "unread");
    case "attention": return events.filter((event) => event.kind === "attention" || event.requiresInput || event.state === "attention");
    case "active": return events.filter((event) => event.state === "queued" || event.state === "running" || event.state === "waiting");
    case "completed": return events.filter((event) => event.state === "completed");
    case "failures": return events.filter((event) => event.state === "failed");
    case "planned": return events.filter((event) => event.state === "planned" || event.durability === "planned");
    case "chat":
    case "project":
    case "background":
    case "notification":
    case "run": return events.filter((event) => event.source === filter);
    case "all":
    default: return [...events];
  }
}

export function buildUnifiedEventProjection(input: UnifiedEventProjectionInput): UnifiedEventProjection {
  const selectedFilter = enumValue(input.selectedFilter, FILTER_VALUES, "all");
  const allEvents = dedupeUnifiedEvents(input.events);
  return {
    schema: UNIFIED_EVENT_SCHEMA,
    version: UNIFIED_EVENT_VERSION,
    scope: UNIFIED_EVENT_SCOPE,
    generatedAt: safeGeneratedAt(input.generatedAt ?? new Date().toISOString()),
    selectedFilter,
    events: filterUnifiedEvents(allEvents, selectedFilter),
    counts: buildCounts(allEvents),
    boundary: {
      rendererOnly: true,
      noDurableWrite: true,
      noProviderRequest: true,
      noScheduler: true,
      noNotificationAck: true,
    },
  };
}

function markdownValue(value: string | null): string {
  return value === null ? "Not retained" : value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function serializeUnifiedEventProjection(
  projection: UnifiedEventProjection,
  format: UnifiedEventFormat,
): string {
  if (format === "json") return `${JSON.stringify(projection, null, 2)}\n`;
  const lines = [
    "# Omnia unified event preview",
    "",
    `> ${UNIFIED_EVENT_BOUNDARY}`,
    "",
    `- Schema: ${projection.schema}`,
    `- Generated: ${markdownValue(projection.generatedAt)}`,
    `- Filter: ${projection.selectedFilter}`,
    `- Events: ${projection.events.length} of ${projection.counts.total}`,
    `- Unread: ${projection.counts.unread}`,
    `- Attention: ${projection.counts.attention}`,
    `- Active: ${projection.counts.active}`,
    `- Completed: ${projection.counts.completed}`,
    `- Failures: ${projection.counts.failures}`,
    `- Planned: ${projection.counts.planned}`,
    "",
    "## Events",
    "",
  ];
  if (projection.events.length === 0) lines.push("No events match the selected filter.", "");
  for (const event of projection.events) {
    lines.push(
      `### ${markdownValue(event.title || event.id)}`,
      "",
      `- Source: ${event.source}`,
      `- Kind: ${event.kind}`,
      `- State: ${event.state}`,
      `- Visibility: ${event.visibility}`,
      `- Durability: ${event.durability}`,
      `- Priority: ${event.priority}`,
      `- Occurred: ${markdownValue(event.occurredAt)}`,
      `- Source label: ${markdownValue(event.sourceLabel)}`,
      ...(event.requiresInput ? ["- Requires input: yes"] : []),
      ...(event.occurrenceCount > 1 ? [`- Grouped occurrences: ${event.occurrenceCount}`] : []),
      "",
      markdownValue(event.summary),
      "",
    );
  }
  return lines.join("\n");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isUnifiedEventAction(value: unknown): value is UnifiedEventAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  return (
    typeof action.id === "string" && action.id.trim().length > 0 &&
    typeof action.label === "string" && action.label.trim().length > 0 &&
    ACTION_KIND_VALUES.includes(action.kind as UnifiedEventAction["kind"]) &&
    ACTION_DISPOSITION_VALUES.includes(action.disposition as NotificationAction["disposition"])
  );
}

function isUnifiedEvent(value: unknown): value is UnifiedEventRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" && event.id.trim().length > 0 &&
    typeof event.dedupeKey === "string" && event.dedupeKey.trim().length > 0 &&
    SOURCE_VALUES.includes(event.source as UnifiedEventSource) &&
    KIND_VALUES.includes(event.kind as UnifiedEventKind) &&
    STATE_VALUES.includes(event.state as UnifiedEventState) &&
    VISIBILITY_VALUES.includes(event.visibility as UnifiedEventVisibility) &&
    DURABILITY_VALUES.includes(event.durability as UnifiedEventDurability) &&
    PRIORITY_VALUES.includes(event.priority as UnifiedEventPriority) &&
    typeof event.title === "string" && typeof event.summary === "string" &&
    typeof event.occurredAt === "string" && event.occurredAt.trim().length > 0 &&
    typeof event.sourceLabel === "string" && typeof event.requiresInput === "boolean" &&
    isNullableString(event.detail) &&
    isNullableString(event.sourceType) &&
    isNullableString(event.projectId) &&
    isNullableString(event.conversationId) &&
    isNullableString(event.runId) &&
    isNullableString(event.parentEventId) &&
    Array.isArray(event.actions) && event.actions.every(isUnifiedEventAction) &&
    typeof event.occurrenceCount === "number" && Number.isSafeInteger(event.occurrenceCount) &&
    event.occurrenceCount >= 1 && event.occurrenceCount <= UNIFIED_EVENT_MAX_OCCURRENCES
  );
}

export function parseUnifiedEventPreview(payload: string): UnifiedEventProjection | null {
  if (typeof payload !== "string") return null;
  const text = payload.replace(/^\uFEFF/, "");
  if (new TextEncoder().encode(text).byteLength > UNIFIED_EVENT_MAX_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const boundary = record.boundary;
    if (
      record.schema !== UNIFIED_EVENT_SCHEMA ||
      record.version !== UNIFIED_EVENT_VERSION ||
      record.scope !== UNIFIED_EVENT_SCOPE ||
      !Array.isArray(record.events) ||
      record.events.length > UNIFIED_EVENT_MAX_EVENTS ||
      typeof record.generatedAt !== "string" || !Number.isFinite(Date.parse(record.generatedAt)) ||
      !boundary || typeof boundary !== "object" || Array.isArray(boundary)
    ) return null;
    const boundaryRecord = boundary as Record<string, unknown>;
    if (!(boundaryRecord.rendererOnly === true && boundaryRecord.noDurableWrite === true && boundaryRecord.noProviderRequest === true && boundaryRecord.noScheduler === true && boundaryRecord.noNotificationAck === true)) return null;
    if (!record.events.every(isUnifiedEvent)) return null;
    return buildUnifiedEventProjection({
      generatedAt: record.generatedAt,
      selectedFilter: enumValue(record.selectedFilter, FILTER_VALUES, "all"),
      events: record.events as UnifiedEventRecord[],
    });
  } catch {
    return null;
  }
}
