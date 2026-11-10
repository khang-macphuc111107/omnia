import { describe, expect, it } from "vitest";
import {
  buildNotificationCenterProjection,
  filterNotificationItems,
  NOTIFICATION_CENTER_BOUNDARY,
  parseNotificationCenterPreview,
  serializeNotificationCenter,
} from "./notification-center-contract";
import type { NotificationItem } from "./notification-center-contract";

const BASE_TIME = "2026-09-20T10:00:00.000Z";

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: "notice-1",
    dedupeKey: "run-1-complete",
    kind: "completion",
    title: "Run completed",
    summary: "The background run completed successfully.",
    status: "unread",
    priority: "normal",
    occurredAt: BASE_TIME,
    sourceLabel: "Background work",
    sourceType: "run",
    runId: "run-1",
    requiresInput: false,
    channels: ["in-app", "toast"],
    actions: [{ id: "open", label: "Open run", kind: "open-run", disposition: "available" }],
    ...overrides,
  };
}

describe("notification-center-contract", () => {
  it("deduplicates repeated events, groups occurrences, and computes attention counts", () => {
    const projection = buildNotificationCenterProjection({
      items: [
        item(),
        item({ id: "notice-2", occurredAt: "2026-09-20T10:01:00.000Z" }),
        item({
          id: "notice-3",
          dedupeKey: "approval-1",
          kind: "approval",
          title: "Approval needed",
          summary: "Review the requested action.",
          priority: "urgent",
          requiresInput: true,
          status: "unread",
        }),
      ],
      selectedFilter: "attention",
    });

    expect(projection.items).toHaveLength(1);
    expect(projection.items[0]?.kind).toBe("approval");
    expect(projection.counts.all).toBe(2);
    expect(projection.counts.completions).toBe(1);
    expect(projection.counts.requiresInput).toBe(1);
    expect(filterNotificationItems(projection.items, "attention")).toHaveLength(1);
  });

  it("redacts sensitive text in JSON and Markdown exports", () => {
    const projection = buildNotificationCenterProjection({
      generatedAt: BASE_TIME,
      items: [
        item({
          title: "Token sk-test-secret",
          summary: "Bearer abcdef123456 and C:\\Users\\khang\\secret.txt",
        }),
      ],
    });
    const json = serializeNotificationCenter(projection, "json");
    const markdown = serializeNotificationCenter(projection, "markdown");

    expect(json).toContain("[REDACTED_TOKEN]");
    expect(json).not.toContain("sk-test-secret");
    expect(json).not.toContain("abcdef123456");
    expect(json).not.toContain("C:\\\\Users\\\\khang");
    expect(markdown).toContain(NOTIFICATION_CENTER_BOUNDARY);
    expect(markdown).toContain("## Counts");
  });

  it("round-trips a portable JSON preview and rejects malformed boundaries", () => {
    const projection = buildNotificationCenterProjection({ generatedAt: BASE_TIME, items: [item()] });
    const payload = serializeNotificationCenter(projection, "json");
    const parsed = parseNotificationCenterPreview(payload);
    expect(parsed?.schema).toBe(projection.schema);
    expect(parsed?.items).toHaveLength(1);
    expect(parseNotificationCenterPreview(payload.replace(projection.schema, "unknown.schema"))).toBeNull();
    expect(parseNotificationCenterPreview(payload.replace('"noDurableWrite": true', '"noDurableWrite": false'))).toBeNull();
    expect(parseNotificationCenterPreview(payload.replace('"generatedAt": "2026-09-20T10:00:00.000Z"', '"generatedAt": "not-a-date"'))).toBeNull();
    expect(parseNotificationCenterPreview(payload.replace('"requiresInput": false', '"requiresInput": "false"'))).toBeNull();
    expect(parseNotificationCenterPreview(payload.replace('"runId": "run-1"', '"runId": 12'))).toBeNull();
    expect(parseNotificationCenterPreview(payload.replace('"occurrenceCount": 1', '"occurrenceCount": 0'))).toBeNull();
  });
});
