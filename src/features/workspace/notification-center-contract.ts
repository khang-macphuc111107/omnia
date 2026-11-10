import { redactDiagnosticText } from "./diagnostics-session-contract";

export const NOTIFICATION_CENTER_SCHEMA = "omnia.notification-center.preview.v1" as const;
export const NOTIFICATION_CENTER_MAX_BYTES = 512 * 1024;
export const NOTIFICATION_CENTER_BOUNDARY =
  "Renderer-local notification projection only. Native delivery, durable acknowledgement, provider dispatch, OS notifications, and background scheduling are not connected.";

export type NotificationCenterFormat = "json" | "markdown";
export type NotificationKind =
  | "attention"
  | "completion"
  | "failure"
  | "indexing"
  | "approval"
  | "info";
export type NotificationStatus = "unread" | "read" | "snoozed" | "dismissed";
export type NotificationPriority = "urgent" | "high" | "normal" | "low";
export type NotificationChannel = "in-app" | "toast" | "screen-reader" | "background";
export type NotificationFilter =
  | "all"
  | "unread"
  | "snoozed"
  | "dismissed"
  | "attention"
  | "failures"
  | "completions"
  | "indexing"
  | "approvals";

export type NotificationActionKind =
  | "open-chat"
  | "open-run"
  | "review"
  | "retry"
  | "mark-read"
  | "mark-unread"
  | "dismiss"
  | "restore"
  | "snooze"
  | "copy";
export type NotificationActionDisposition = "available" | "planned" | "unavailable";

export interface NotificationAction {
  readonly id: string;
  readonly label: string;
  readonly kind: NotificationActionKind;
  readonly disposition: NotificationActionDisposition;
}

export interface NotificationItem {
  readonly id: string;
  readonly dedupeKey: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly summary: string;
  readonly status: NotificationStatus;
  readonly priority: NotificationPriority;
  readonly occurredAt: string;
  readonly sourceLabel: string;
  readonly sourceType?: string;
  readonly conversationId?: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly requiresInput: boolean;
  readonly channels: readonly NotificationChannel[];
  readonly actions: readonly NotificationAction[];
  readonly readAt?: string | null;
  readonly snoozedUntil?: string | null;
  readonly occurrenceCount?: number;
}

export interface NotificationCenterInput {
  readonly items: readonly NotificationItem[];
  readonly generatedAt?: string;
  readonly selectedFilter?: NotificationFilter;
}

export interface NotificationCenterCounts {
  readonly all: number;
  readonly unread: number;
  readonly attention: number;
  readonly failures: number;
  readonly completions: number;
  readonly indexing: number;
  readonly approvals: number;
  readonly requiresInput: number;
}

export interface NotificationCenterProjection {
  readonly schema: typeof NOTIFICATION_CENTER_SCHEMA;
  readonly generatedAt: string;
  readonly selectedFilter: NotificationFilter;
  readonly items: readonly NotificationItem[];
  readonly counts: NotificationCenterCounts;
  readonly boundary: {
    readonly rendererOnly: true;
    readonly noDurableWrite: true;
    readonly noProviderRequest: true;
    readonly noOsNotification: true;
    readonly noBackgroundScheduler: true;
  };
}

const KIND_VALUES: readonly NotificationKind[] = [
  "attention",
  "completion",
  "failure",
  "indexing",
  "approval",
  "info",
];
const STATUS_VALUES: readonly NotificationStatus[] = ["unread", "read", "snoozed", "dismissed"];
const PRIORITY_VALUES: readonly NotificationPriority[] = ["urgent", "high", "normal", "low"];
const CHANNEL_VALUES: readonly NotificationChannel[] = ["in-app", "toast", "screen-reader", "background"];
const FILTER_VALUES: readonly NotificationFilter[] = [
  "all",
  "unread",
  "snoozed",
  "dismissed",
  "attention",
  "failures",
  "completions",
  "indexing",
  "approvals",
];
const ACTION_KIND_VALUES: readonly NotificationActionKind[] = [
  "open-chat",
  "open-run",
  "review",
  "retry",
  "mark-read",
  "mark-unread",
  "dismiss",
  "restore",
  "snooze",
  "copy",
];
const ACTION_DISPOSITION_VALUES: readonly NotificationActionDisposition[] = [
  "available",
  "planned",
  "unavailable",
];

const PRIORITY_RANK: Record<NotificationPriority, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

function safeText(value: unknown, maxLength: number): string {
  return redactDiagnosticText(typeof value === "string" ? value : String(value ?? "")).trim().slice(0, maxLength);
}

function safeOptionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = safeText(value, maxLength);
  return text || undefined;
}

function safeNullableText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return safeText(value, maxLength) || null;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;
}

function normalizeAction(action: NotificationAction): NotificationAction {
  return {
    id: safeText(action.id, 120),
    label: safeText(action.label, 120),
    kind: enumValue(action.kind, ACTION_KIND_VALUES, "copy"),
    disposition: enumValue(action.disposition, ACTION_DISPOSITION_VALUES, "unavailable"),
  };
}

function normalizeItem(item: NotificationItem): NotificationItem {
  const channels = Array.from(new Set(item.channels.filter((channel) => CHANNEL_VALUES.includes(channel))));
  const actions = item.actions
    .map(normalizeAction)
    .filter((action) => action.id.length > 0 && action.label.length > 0)
    .slice(0, 8);
  const readAt = safeNullableText(item.readAt, 80);
  const snoozedUntil = safeNullableText(item.snoozedUntil, 80);
  return {
    id: safeText(item.id, 160),
    dedupeKey: safeText(item.dedupeKey || item.id, 200),
    kind: enumValue(item.kind, KIND_VALUES, "info"),
    title: safeText(item.title, 240),
    summary: safeText(item.summary, 800),
    status: enumValue(item.status, STATUS_VALUES, "unread"),
    priority: enumValue(item.priority, PRIORITY_VALUES, "normal"),
    occurredAt: safeText(item.occurredAt, 80),
    sourceLabel: safeText(item.sourceLabel, 180),
    ...(safeOptionalText(item.sourceType, 120) ? { sourceType: safeText(item.sourceType, 120) } : {}),
    ...(safeOptionalText(item.conversationId, 160) ? { conversationId: safeText(item.conversationId, 160) } : {}),
    ...(safeOptionalText(item.projectId, 160) ? { projectId: safeText(item.projectId, 160) } : {}),
    ...(safeOptionalText(item.runId, 160) ? { runId: safeText(item.runId, 160) } : {}),
    requiresInput: item.requiresInput === true,
    channels,
    actions,
    ...(readAt !== undefined ? { readAt } : {}),
    ...(snoozedUntil !== undefined ? { snoozedUntil } : {}),
    occurrenceCount: Math.max(1, Math.floor(Number(item.occurrenceCount ?? 1) || 1)),
  };
}

function occurredAtMs(item: NotificationItem): number {
  const parsed = Date.parse(item.occurredAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isNotificationItem(value: unknown): value is NotificationItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    item.id.trim().length === 0 ||
    typeof item.dedupeKey !== "string" ||
    item.dedupeKey.trim().length === 0 ||
    typeof item.title !== "string" ||
    typeof item.summary !== "string" ||
    typeof item.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(item.occurredAt)) ||
    typeof item.sourceLabel !== "string" ||
    typeof item.requiresInput !== "boolean" ||
    !Array.isArray(item.channels) ||
    !Array.isArray(item.actions)
  ) {
    return false;
  }
  const optionalStrings = ["sourceType", "conversationId", "projectId", "runId"] as const;
  if (optionalStrings.some((key) => item[key] !== undefined && typeof item[key] !== "string")) return false;
  const optionalNullableStrings = ["readAt", "snoozedUntil"] as const;
  if (
    optionalNullableStrings.some(
      (key) => item[key] !== undefined && item[key] !== null && typeof item[key] !== "string",
    )
  ) {
    return false;
  }
  if (
    item.occurrenceCount !== undefined &&
    (typeof item.occurrenceCount !== "number" || !Number.isInteger(item.occurrenceCount) || item.occurrenceCount < 1)
  ) {
    return false;
  }
  if (!KIND_VALUES.includes(item.kind as NotificationKind)) return false;
  if (!STATUS_VALUES.includes(item.status as NotificationStatus)) return false;
  if (!PRIORITY_VALUES.includes(item.priority as NotificationPriority)) return false;
  if (!item.channels.every((channel) => CHANNEL_VALUES.includes(channel as NotificationChannel))) return false;
  if (
    !item.actions.every((action) => {
      if (!action || typeof action !== "object" || Array.isArray(action)) return false;
      const candidate = action as Record<string, unknown>;
      return (
        typeof candidate.id === "string" &&
        candidate.id.trim().length > 0 &&
        typeof candidate.label === "string" &&
        candidate.label.trim().length > 0 &&
        ACTION_KIND_VALUES.includes(candidate.kind as NotificationActionKind) &&
        ACTION_DISPOSITION_VALUES.includes(candidate.disposition as NotificationActionDisposition)
      );
    })
  ) {
    return false;
  }
  return true;
}

function compareItems(left: NotificationItem, right: NotificationItem): number {
  const priorityDelta = PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority];
  if (priorityDelta !== 0) return priorityDelta;
  const dateDelta = occurredAtMs(right) - occurredAtMs(left);
  if (dateDelta !== 0) return dateDelta;
  return left.id.localeCompare(right.id);
}

function dedupeItems(items: readonly NotificationItem[]): NotificationItem[] {
  const byKey = new Map<string, NotificationItem>();
  for (const candidate of items.map(normalizeItem)) {
    const key = candidate.dedupeKey || candidate.id;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }
    const preferred = compareItems(candidate, existing) < 0 ? candidate : existing;
    byKey.set(key, {
      ...preferred,
      occurrenceCount: (existing.occurrenceCount ?? 1) + (candidate.occurrenceCount ?? 1),
    });
  }
  return Array.from(byKey.values()).sort(compareItems);
}

function buildCounts(items: readonly NotificationItem[]): NotificationCenterCounts {
  return {
    all: items.length,
    unread: items.filter((item) => item.status === "unread").length,
    attention: items.filter((item) => item.kind === "attention" || item.requiresInput).length,
    failures: items.filter((item) => item.kind === "failure").length,
    completions: items.filter((item) => item.kind === "completion").length,
    indexing: items.filter((item) => item.kind === "indexing").length,
    approvals: items.filter((item) => item.kind === "approval").length,
    requiresInput: items.filter((item) => item.requiresInput).length,
  };
}

export function filterNotificationItems(
  items: readonly NotificationItem[],
  filter: NotificationFilter,
): NotificationItem[] {
  switch (filter) {
    case "unread":
      return items.filter((item) => item.status === "unread");
    case "snoozed":
      return items.filter((item) => item.status === "snoozed");
    case "dismissed":
      return items.filter((item) => item.status === "dismissed");
    case "attention":
      return items.filter((item) => item.kind === "attention" || item.requiresInput);
    case "failures":
      return items.filter((item) => item.kind === "failure");
    case "completions":
      return items.filter((item) => item.kind === "completion");
    case "indexing":
      return items.filter((item) => item.kind === "indexing");
    case "approvals":
      return items.filter((item) => item.kind === "approval");
    case "all":
    default:
      return [...items];
  }
}

export function buildNotificationCenterProjection(
  input: NotificationCenterInput,
): NotificationCenterProjection {
  const selectedFilter = enumValue(input.selectedFilter, FILTER_VALUES, "all");
  const items = dedupeItems(input.items);
  return {
    schema: NOTIFICATION_CENTER_SCHEMA,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    selectedFilter,
    items: filterNotificationItems(items, selectedFilter),
    counts: buildCounts(items),
    boundary: {
      rendererOnly: true,
      noDurableWrite: true,
      noProviderRequest: true,
      noOsNotification: true,
      noBackgroundScheduler: true,
    },
  };
}

export function notificationCenterSummary(projection: NotificationCenterProjection): string {
  const unread = projection.counts.unread;
  const attention = projection.counts.requiresInput;
  return `${projection.counts.all} notifications · ${unread} unread · ${attention} need input`;
}

function markdownValue(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function serializeNotificationCenter(
  projection: NotificationCenterProjection,
  format: NotificationCenterFormat,
): string {
  if (format === "json") return `${JSON.stringify(projection, null, 2)}\n`;
  const lines = [
    "# Omnia notification center preview",
    "",
    `> ${NOTIFICATION_CENTER_BOUNDARY}`,
    "",
    `- Schema: ${projection.schema}`,
    `- Generated: ${markdownValue(projection.generatedAt)}`,
    `- Filter: ${projection.selectedFilter}`,
    `- Summary: ${notificationCenterSummary(projection)}`,
    "",
    "## Counts",
    "",
    `- All: ${projection.counts.all}`,
    `- Unread: ${projection.counts.unread}`,
    `- Attention: ${projection.counts.attention}`,
    `- Requires input: ${projection.counts.requiresInput}`,
    `- Failures: ${projection.counts.failures}`,
    `- Completions: ${projection.counts.completions}`,
    `- Indexing: ${projection.counts.indexing}`,
    `- Approvals: ${projection.counts.approvals}`,
    "",
    "## Notifications",
    "",
  ];
  if (projection.items.length === 0) lines.push("No notifications match the current filter.", "");
  for (const item of projection.items) {
    lines.push(
      `### ${markdownValue(item.title || item.id)}`,
      "",
      `- Kind: ${item.kind}`,
      `- Priority: ${item.priority}`,
      `- Status: ${item.status}`,
      `- Source: ${markdownValue(item.sourceLabel)}`,
      `- Occurred: ${markdownValue(item.occurredAt)}`,
      ...(item.requiresInput ? ["- Requires input: yes"] : []),
      ...(item.occurrenceCount && item.occurrenceCount > 1 ? [`- Grouped occurrences: ${item.occurrenceCount}`] : []),
      "",
      markdownValue(item.summary),
      "",
    );
  }
  return lines.join("\n");
}

export function parseNotificationCenterPreview(payload: string): NotificationCenterProjection | null {
  const text = payload.replace(/^\uFEFF/, "");
  if (new TextEncoder().encode(text).byteLength > NOTIFICATION_CENTER_MAX_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.schema !== NOTIFICATION_CENTER_SCHEMA || !Array.isArray(record.items)) return null;
    const boundary = record.boundary;
    if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) return null;
    const boundaryRecord = boundary as Record<string, unknown>;
    const boundaryKeys = [
      "rendererOnly",
      "noDurableWrite",
      "noProviderRequest",
      "noOsNotification",
      "noBackgroundScheduler",
    ];
    if (!boundaryKeys.every((key) => boundaryRecord[key] === true)) return null;
    if (typeof record.generatedAt !== "string" || !Number.isFinite(Date.parse(record.generatedAt))) return null;
    const items = record.items as unknown[];
    if (!items.every(isNotificationItem)) return null;
    const normalizedItems = items;
    const generatedAt = record.generatedAt;
    return buildNotificationCenterProjection({
      items: normalizedItems,
      ...(typeof generatedAt === "string" ? { generatedAt } : {}),
      selectedFilter: enumValue(record.selectedFilter, FILTER_VALUES, "all"),
    });
  } catch {
    return null;
  }
}

export function downloadNotificationCenterExport(
  payload: string,
  format: NotificationCenterFormat,
): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(
    new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-notification-center-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
