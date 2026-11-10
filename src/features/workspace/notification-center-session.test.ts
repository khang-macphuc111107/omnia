import { describe, expect, it } from "vitest";

import type { NotificationItem } from "./notification-center-contract";
import {
  applyNotificationSessionOverrides,
  buildSnoozedUntil,
  clearNotificationSessionOverrides,
  patchNotificationSessionOverrides,
} from "./notification-center-session";

const item: NotificationItem = {
  id: "notice-1",
  dedupeKey: "notice-1",
  kind: "completion",
  title: "Done",
  summary: "Completed.",
  status: "unread",
  priority: "normal",
  occurredAt: "2026-09-20T09:00:00.000Z",
  sourceLabel: "Preview",
  requiresInput: false,
  channels: ["in-app"],
  actions: [],
};

describe("notification-center-session", () => {
  it("applies read, snooze, dismiss and restore overrides without mutating source items", () => {
    const changedAt = "2026-09-20T10:00:00.000Z";
    const read = patchNotificationSessionOverrides({}, [item], "read", changedAt);
    expect(applyNotificationSessionOverrides([item], read)[0]).toMatchObject({ status: "read", readAt: changedAt });
    const snoozed = patchNotificationSessionOverrides(read, [item], "snoozed", changedAt);
    expect(applyNotificationSessionOverrides([item], snoozed)[0]).toMatchObject({
      status: "snoozed",
      snoozedUntil: "2026-09-20T10:15:00.000Z",
    });
    const dismissed = patchNotificationSessionOverrides(snoozed, [item], "dismissed", changedAt);
    expect(applyNotificationSessionOverrides([item], dismissed)[0]?.status).toBe("dismissed");
    expect(item.status).toBe("unread");
  });

  it("uses a bounded snooze timestamp and clears selected overrides", () => {
    const until = buildSnoozedUntil("2026-09-20T10:00:00.000Z");
    expect(until).toBe("2026-09-20T10:15:00.000Z");
    const overrides = patchNotificationSessionOverrides({}, [item], "read", "2026-09-20T10:00:00.000Z");
    expect(clearNotificationSessionOverrides(overrides, [item.id])).toEqual({});
  });
});

