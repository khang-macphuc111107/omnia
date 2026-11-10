import { describe, expect, it } from "vitest";

import {
  createNotificationTriageSavedView,
  DEFAULT_NOTIFICATION_TRIAGE_VIEW_STATE,
  nextNotificationTriageViewId,
  normalizeNotificationTriageViewName,
  normalizeNotificationTriageViewState,
  trimNotificationTriageSavedViews,
  updateNotificationTriageSavedView,
} from "./notification-center-triage-views";

describe("notification-center-triage-views", () => {
  it("normalizes view state and names to safe renderer-local values", () => {
    expect(normalizeNotificationTriageViewName("  Urgent queue  ")).toBe("Urgent queue");
    expect(normalizeNotificationTriageViewName("   ")).toBe("Untitled triage view");
    expect(normalizeNotificationTriageViewState({ filter: "invalid" as never, query: "  provider  " })).toEqual({
      ...DEFAULT_NOTIFICATION_TRIAGE_VIEW_STATE,
      query: "provider",
    });
  });

  it("creates and updates a complete saved view without mutating the source object", () => {
    const original = createNotificationTriageSavedView({ id: "triage-view-1", name: "Queue", state: { lane: "urgent" }, savedAt: "2026-09-27T00:00:00.000Z" });
    const updated = updateNotificationTriageSavedView(original, { name: "Urgent queue", state: { sort: "newest" }, savedAt: "2026-09-27T01:00:00.000Z" });

    expect(original.name).toBe("Queue");
    expect(original.state).toEqual({ ...DEFAULT_NOTIFICATION_TRIAGE_VIEW_STATE, lane: "urgent" });
    expect(updated).toMatchObject({
      id: "triage-view-1",
      name: "Urgent queue",
      savedAt: "2026-09-27T01:00:00.000Z",
      state: { lane: "urgent", sort: "newest" },
    });
  });

  it("allocates collision-free ids and keeps the most recent bounded views", () => {
    const views = Array.from({ length: 13 }, (_, index) => createNotificationTriageSavedView({ id: `triage-view-${index + 1}`, name: `View ${index + 1}` }));
    expect(nextNotificationTriageViewId(views)).toBe("triage-view-14");
    expect(trimNotificationTriageSavedViews(views)).toHaveLength(12);
    expect(trimNotificationTriageSavedViews(views)[0]?.name).toBe("View 2");
  });
});
