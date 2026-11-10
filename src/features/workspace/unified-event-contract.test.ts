import { describe, expect, it } from "vitest";

import type { BackgroundWorkItem } from "./background-work-projection";
import type { NotificationItem } from "./notification-center-contract";
import {
  buildUnifiedEventProjection,
  filterUnifiedEvents,
  parseUnifiedEventPreview,
  serializeUnifiedEventProjection,
  unifiedEventFromBackgroundWork,
  unifiedEventFromNotification,
  unifiedEventFromProjectActivity,
  unifiedEventFromRunTimeline,
  unifiedEventsFromSources,
  UNIFIED_EVENT_BOUNDARY,
} from "./unified-event-contract";
import type { ProjectActivityEvent } from "./project-activity-timeline";
import type { RunTimelineEventView } from "./evidence-types";

const BASE_TIME = "2026-09-20T10:00:00.000Z";

const projectEvent: ProjectActivityEvent = {
  id: "project-1:context-status",
  kind: "context",
  type: "context.status",
  title: "Context readiness inspected",
  detail: "Context is ready for this Project.",
  occurredAt: "Current selection",
  actor: "Renderer projection",
  status: "preview",
  sourceLabel: "Context health",
  relatedId: "project-1",
  relatedLabel: "Omnia",
};

const notification: NotificationItem = {
  id: "notice-1",
  dedupeKey: "run-1-complete",
  kind: "completion",
  title: "Run completed",
  summary: "The run completed successfully.",
  status: "unread",
  priority: "normal",
  occurredAt: BASE_TIME,
  sourceLabel: "Background work",
  sourceType: "run",
  runId: "run-1",
  requiresInput: false,
  channels: ["in-app"],
  actions: [{ id: "open", label: "Open run", kind: "open-run", disposition: "available" }],
};

const backgroundItem: BackgroundWorkItem = {
  id: "run:run-1",
  kind: "run-timeline",
  state: "completed",
  title: "Run completed",
  subtitle: "Finished",
  detail: "The same run has a native projection.",
  conversationId: "chat-1",
  runId: "run-1",
  updatedAt: BASE_TIME,
  durability: "native-projection",
  attention: false,
  actions: ["inspect", "open-chat"],
};

const runEvent: RunTimelineEventView = {
  id: "run-event-1",
  runId: "run-1",
  parentEventId: null,
  sequence: 1,
  type: "run.completed",
  stage: "finalization",
  status: "complete",
  summary: "Run completed",
  detail: "Final response was produced.",
  startedAt: BASE_TIME,
  endedAt: BASE_TIME,
  source: "harness",
  providerLabel: null,
  attemptOrdinal: 1,
  citationIds: [],
};

describe("unified-event-contract", () => {
  it("adapts the four visible event sources into one vocabulary", () => {
    expect(unifiedEventFromProjectActivity(projectEvent)).toMatchObject({
      source: "project",
      kind: "progress",
      state: "info",
      durability: "renderer-session",
    });
    expect(unifiedEventFromNotification(notification)).toMatchObject({
      source: "notification",
      kind: "completion",
      state: "completed",
      visibility: "unread",
    });
    expect(unifiedEventFromBackgroundWork(backgroundItem)).toMatchObject({
      source: "background",
      state: "completed",
      durability: "native-projection",
    });
    expect(unifiedEventFromRunTimeline(runEvent)).toMatchObject({
      source: "run",
      kind: "completion",
      state: "completed",
      runId: "run-1",
    });
  });

  it("deduplicates repeated source facts without losing native precedence or occurrence count", () => {
    const events = unifiedEventsFromSources({
      notifications: [notification, { ...notification, id: "notice-2" }],
      backgroundWork: [backgroundItem],
      runTimeline: [runEvent],
    });

    const completed = events.filter((event) => event.state === "completed");
    expect(completed).toHaveLength(3);
    const notices = events.find((event) => event.source === "notification");
    expect(notices?.occurrenceCount).toBe(2);

    const projection = buildUnifiedEventProjection({ events, generatedAt: BASE_TIME, selectedFilter: "completed" });
    expect(projection.events.every((event) => event.state === "completed")).toBe(true);
    expect(projection.counts.completed).toBe(3);
    expect(projection.counts.nativeProjection).toBe(2);
  });

  it("filters by source and attention while preserving counts from the full set", () => {
    const attention = unifiedEventFromNotification({
      ...notification,
      id: "notice-attention",
      dedupeKey: "approval-1",
      kind: "approval",
      title: "Approval needed",
      requiresInput: true,
      priority: "urgent",
    });
    const events = [unifiedEventFromProjectActivity(projectEvent), attention];

    expect(filterUnifiedEvents(events, "project")).toHaveLength(1);
    expect(filterUnifiedEvents(events, "attention")).toHaveLength(1);
    const projection = buildUnifiedEventProjection({ events, generatedAt: BASE_TIME, selectedFilter: "attention" });
    expect(projection.events).toHaveLength(1);
    expect(projection.counts.total).toBe(2);
    expect(projection.counts.requiresInput).toBe(1);
  });

  it("redacts exports, round-trips portable JSON, and rejects an unsafe boundary", () => {
    const source = unifiedEventFromNotification({
      ...notification,
      title: "Token sk-test-secret",
      summary: "Bearer abcdef123456 from C:\\Users\\khang\\secret.txt",
    });
    const projection = buildUnifiedEventProjection({ events: [source], generatedAt: BASE_TIME });
    const json = serializeUnifiedEventProjection(projection, "json");
    const markdown = serializeUnifiedEventProjection(projection, "markdown");

    expect(json).toContain("[REDACTED_TOKEN]");
    expect(json).not.toContain("sk-test-secret");
    expect(json).not.toContain("abcdef123456");
    expect(json).not.toContain("C:\\\\Users\\\\khang");
    expect(markdown).toContain(UNIFIED_EVENT_BOUNDARY);
    expect(parseUnifiedEventPreview(json)?.events).toHaveLength(1);
    expect(parseUnifiedEventPreview(json.replace('"noScheduler": true', '"noScheduler": false'))).toBeNull();
    expect(parseUnifiedEventPreview(json.replace("omnia.unified-event.preview.v1", "unknown.schema"))).toBeNull();
  });

  it("hardens direct projections against malformed actions and unbounded counts", () => {
    const malformed = {
      ...unifiedEventFromNotification(notification),
      id: "malformed-action",
      dedupeKey: "malformed-action",
      actions: [null, { id: "", label: "", kind: "provider-internal", disposition: "available" }, {
        id: "provider-internal",
        label: "Provider internal",
        kind: "not-a-real-action",
        disposition: "available",
      }, {
        id: "inspect",
        label: "Inspect",
        kind: "inspect",
        disposition: "not-a-real-disposition",
      }],
      occurrenceCount: Number.POSITIVE_INFINITY,
    } as unknown as import("./unified-event-contract").UnifiedEventRecord;

    const projection = buildUnifiedEventProjection({
      events: [malformed],
      generatedAt: BASE_TIME,
    });

    expect(projection.events).toHaveLength(1);
    expect(projection.events[0]?.actions).toEqual([
      expect.objectContaining({
        id: "inspect",
        kind: "inspect",
        disposition: "unavailable",
      }),
    ]);
    expect(projection.events[0]?.occurrenceCount).toBe(1);
  });

  it("rejects portable events with malformed nullable fields or actions", () => {
    const json = serializeUnifiedEventProjection(
      buildUnifiedEventProjection({ events: [unifiedEventFromNotification(notification)], generatedAt: BASE_TIME }),
      "json",
    );

    const malformedDetail = json.replace('"detail": "The run completed successfully."', '"detail": 42');
    const malformedAction = json.replace('"kind": "open-run"', '"kind": "provider-internal"');

    expect(parseUnifiedEventPreview(malformedDetail)).toBeNull();
    expect(parseUnifiedEventPreview(malformedAction)).toBeNull();
  });
});
