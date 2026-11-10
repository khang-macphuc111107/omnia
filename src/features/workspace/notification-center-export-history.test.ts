import { describe, expect, it } from "vitest";

import {
  appendNotificationExportHistory,
  buildNotificationExportHistoryEntry,
  NOTIFICATION_EXPORT_HISTORY_LIMIT,
  NOTIFICATION_EXPORT_HISTORY_MAX_PAYLOAD_BYTES,
  notificationExportDeliveryLabel,
  notificationExportHistorySummary,
} from "./notification-center-export-history";

const BASE_INPUT = {
  format: "json" as const,
  generatedAt: "2026-09-20T10:00:00.000Z",
  itemCount: 2,
  filter: "all" as const,
  lane: "all",
  source: "all",
  sort: "priority",
  query: "",
  payload: '{"items":[]}',
};

describe("notification-center-export-history", () => {
  it("builds a bounded entry with delivery and view context", () => {
    const entry = buildNotificationExportHistoryEntry({
      ...BASE_INPUT,
      delivery: "snapshot",
      query: "blocked",
    });

    expect(entry).toMatchObject({
      delivery: "snapshot",
      format: "json",
      itemCount: 2,
      lane: "all",
      source: "all",
      query: "blocked",
      payload: '{"items":[]}',
    });
    expect(entry?.id).toContain("notification-export:snapshot:json");
    expect(notificationExportHistorySummary(entry!)).toContain("Pinned snapshot");
  });

  it("deduplicates identical snapshots and keeps newest entries bounded", () => {
    const first = buildNotificationExportHistoryEntry({ ...BASE_INPUT, id: "first", delivery: "copy" })!;
    const duplicate = buildNotificationExportHistoryEntry({ ...BASE_INPUT, id: "duplicate", delivery: "copy" })!;
    const entries = Array.from({ length: NOTIFICATION_EXPORT_HISTORY_LIMIT + 2 }, (_, index) =>
      buildNotificationExportHistoryEntry({
        ...BASE_INPUT,
        id: `entry-${index}`,
        delivery: index % 2 === 0 ? "copy" : "download",
        payload: `payload-${index}`,
      })!,
    );
    const next = appendNotificationExportHistory([first, ...entries], duplicate);

    expect(next).toHaveLength(NOTIFICATION_EXPORT_HISTORY_LIMIT);
    expect(next[0]?.id).toBe("duplicate");
    expect(next.filter((entry) => entry.payload === BASE_INPUT.payload && entry.delivery === "copy")).toHaveLength(1);
  });

  it("rejects oversized payloads and exposes delivery labels", () => {
    const oversized = buildNotificationExportHistoryEntry({
      ...BASE_INPUT,
      payload: "x".repeat(NOTIFICATION_EXPORT_HISTORY_MAX_PAYLOAD_BYTES + 1),
      delivery: "download",
    });

    expect(oversized).toBeNull();
    expect(notificationExportDeliveryLabel("copy")).toBe("Clipboard copy");
    expect(notificationExportDeliveryLabel("download")).toBe("Browser download");
    expect(notificationExportDeliveryLabel("snapshot")).toBe("Pinned snapshot");
  });
});
