import type {
  NotificationCenterFormat,
  NotificationFilter,
} from "./notification-center-contract";

export type NotificationExportDelivery = "copy" | "download" | "snapshot";

export interface NotificationExportHistoryEntry {
  readonly id: string;
  readonly delivery: NotificationExportDelivery;
  readonly format: NotificationCenterFormat;
  readonly generatedAt: string;
  readonly itemCount: number;
  readonly filter: NotificationFilter;
  readonly lane: string;
  readonly source: string;
  readonly sort: string;
  readonly query: string;
  readonly payload: string;
}

export interface NotificationExportHistoryInput {
  readonly delivery: NotificationExportDelivery;
  readonly format: NotificationCenterFormat;
  readonly generatedAt: string;
  readonly itemCount: number;
  readonly filter: NotificationFilter;
  readonly lane: string;
  readonly source: string;
  readonly sort: string;
  readonly query?: string;
  readonly payload: string;
  readonly id?: string;
}

export const NOTIFICATION_EXPORT_HISTORY_LIMIT = 8;
export const NOTIFICATION_EXPORT_HISTORY_MAX_PAYLOAD_BYTES = 128 * 1024;

function safeText(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function safeCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

function payloadByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function historyKey(entry: Pick<NotificationExportHistoryEntry, "delivery" | "format" | "filter" | "lane" | "source" | "sort" | "query" | "payload">): string {
  return [
    entry.delivery,
    entry.format,
    entry.filter,
    entry.lane,
    entry.source,
    entry.sort,
    entry.query,
    entry.payload,
  ].join("\u0000");
}

/**
 * Creates a bounded export-history record without writing a file or touching
 * native persistence. Payloads larger than the preview budget are rejected so
 * an accidental large export cannot make the renderer history unbounded.
 */
export function buildNotificationExportHistoryEntry(
  input: NotificationExportHistoryInput,
): NotificationExportHistoryEntry | null {
  const payload = String(input.payload ?? "");
  if (!payload || payloadByteLength(payload) > NOTIFICATION_EXPORT_HISTORY_MAX_PAYLOAD_BYTES) return null;
  const generatedAt = safeText(input.generatedAt, 80);
  const format = input.format === "markdown" ? "markdown" : "json";
  const delivery = input.delivery === "download"
    ? "download"
    : input.delivery === "snapshot"
      ? "snapshot"
      : "copy";
  const itemCount = safeCount(input.itemCount);
  const query = safeText(input.query, 120);
  const id = safeText(
    input.id ?? `notification-export:${delivery}:${format}:${generatedAt}:${itemCount}:${payload.length}`,
    240,
  );
  return {
    id,
    delivery,
    format,
    generatedAt,
    itemCount,
    filter: input.filter,
    lane: safeText(input.lane, 80) || "all",
    source: safeText(input.source, 120) || "all",
    sort: safeText(input.sort, 80) || "priority",
    query,
    payload,
  };
}

/**
 * Prepends a new entry, de-duplicates an identical snapshot, and keeps the
 * history bounded. The returned array is newest-first and safe to keep in
 * React state for the current renderer session.
 */
export function appendNotificationExportHistory(
  entries: readonly NotificationExportHistoryEntry[],
  next: NotificationExportHistoryEntry,
): NotificationExportHistoryEntry[] {
  const nextKey = historyKey(next);
  const withoutDuplicate = entries.filter((entry) => historyKey(entry) !== nextKey);
  return [next, ...withoutDuplicate].slice(0, NOTIFICATION_EXPORT_HISTORY_LIMIT);
}

export function notificationExportDeliveryLabel(delivery: NotificationExportDelivery): string {
  if (delivery === "download") return "Browser download";
  if (delivery === "snapshot") return "Pinned snapshot";
  return "Clipboard copy";
}

export function notificationExportHistorySummary(entry: NotificationExportHistoryEntry): string {
  const query = entry.query ? ` · “${entry.query}”` : "";
  return `${entry.format.toUpperCase()} · ${notificationExportDeliveryLabel(entry.delivery)} · ${entry.itemCount} item${entry.itemCount === 1 ? "" : "s"} · ${entry.filter}${query}`;
}
