import { describe, expect, it } from "vitest";

import type { NotificationItem } from "./notification-center-contract";
import {
  buildNotificationTriageView,
  filterNotificationTriageItems,
  listNotificationTriageSources,
  notificationTriageSourceKey,
  sortNotificationTriageItems,
} from "./notification-center-triage";

const item = (overrides: Partial<NotificationItem> = {}): NotificationItem => ({
  id: "info",
  dedupeKey: "info",
  kind: "info",
  title: "Info",
  summary: "Summary",
  status: "read",
  priority: "normal",
  occurredAt: "2026-09-20T09:00:00.000Z",
  sourceLabel: "Workspace",
  sourceType: "workspace",
  requiresInput: false,
  channels: ["in-app"],
  actions: [],
  ...overrides,
});

describe("notification-center-triage", () => {
  const items = [
    item({ id: "approval", dedupeKey: "approval", kind: "approval", title: "Approval", priority: "urgent", status: "unread", requiresInput: true, sourceType: "background" }),
    item({ id: "failure", dedupeKey: "failure", kind: "failure", title: "Failure", priority: "high", occurredAt: "2026-09-20T10:00:00.000Z", sourceType: "provider" }),
    item({ id: "quiet", dedupeKey: "quiet", title: "Quiet", status: "read", priority: "low", sourceType: "research" }),
  ];

  it("exposes stable source keys and sorted dynamic source options", () => {
    expect(notificationTriageSourceKey(items[0]!)).toBe("background");
    expect(listNotificationTriageSources(items)).toEqual(["background", "provider", "research"]);
  });

  it("filters triage lanes and source without mutating the source projection", () => {
    expect(filterNotificationTriageItems(items, { lane: "needs-input", source: "all" }).map((entry) => entry.id)).toEqual(["approval"]);
    expect(filterNotificationTriageItems(items, { lane: "failures", source: "provider" }).map((entry) => entry.id)).toEqual(["failure"]);
    expect(items.map((entry) => entry.id)).toEqual(["approval", "failure", "quiet"]);
  });

  it("sorts by triage priority and deterministic tie breakers", () => {
    const sorted = sortNotificationTriageItems(items, "priority");
    expect(sorted.map((entry) => entry.id)).toEqual(["approval", "failure", "quiet"]);
    expect(sortNotificationTriageItems(items, "newest").map((entry) => entry.id)).toEqual(["failure", "approval", "quiet"]);
    expect(sortNotificationTriageItems(items, "title").map((entry) => entry.id)).toEqual(["approval", "failure", "quiet"]);
  });

  it("builds a composed view for the triage controls", () => {
    expect(buildNotificationTriageView(items, { lane: "urgent", source: "all", sort: "newest" }).map((entry) => entry.id)).toEqual(["failure", "approval"]);
  });
});

