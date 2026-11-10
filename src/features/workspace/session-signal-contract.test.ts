import { afterEach, describe, expect, it } from "vitest";

import {
  applySignalPreferencesToEvents,
  DEFAULT_SIGNAL_PREFERENCES,
  getSignalPreferencesSession,
  parseSignalPreferences,
  resetSignalPreferences,
  resetSignalPreferencesSession,
  serializeSignalPreferences,
  undoSignalPreferences,
  updateSignalPreferences,
} from "./session-signal-contract";
import type { UnifiedEventRecord } from "./unified-event-contract";

const event = (patch: Partial<UnifiedEventRecord>): UnifiedEventRecord => ({
  id: "event-default",
  dedupeKey: "event-default",
  source: "chat",
  kind: "activity",
  state: "info",
  visibility: "read",
  durability: "renderer-session",
  priority: "normal",
  title: "Signal",
  summary: "Renderer-local signal",
  detail: "Details",
  occurredAt: "2026-09-21T10:00:00.000Z",
  sourceLabel: "Chat",
  sourceType: "chat.metadata",
  projectId: null,
  conversationId: null,
  runId: null,
  parentEventId: null,
  requiresInput: false,
  actions: [],
  occurrenceCount: 1,
  ...patch,
});

describe("session signal contract", () => {
  afterEach(() => resetSignalPreferencesSession());

  it("shares source visibility and ordering through one renderer-session contract", () => {
    const events = [
      event({ id: "project-event", dedupeKey: "project-event", source: "project", priority: "urgent", occurredAt: "2026-09-21T09:00:00.000Z" }),
      event({ id: "chat-event", dedupeKey: "chat-event", source: "chat", priority: "normal", occurredAt: "2026-09-21T10:00:00.000Z" }),
      event({ id: "run-event", dedupeKey: "run-event", source: "run", priority: "high", occurredAt: "2026-09-21T08:00:00.000Z" }),
    ];

    updateSignalPreferences({ enabledSources: { ...DEFAULT_SIGNAL_PREFERENCES.enabledSources, chat: false }, grouping: "recent" });
    expect(applySignalPreferencesToEvents(events, getSignalPreferencesSession().present).map((item) => item.id)).toEqual([
      "project-event",
      "run-event",
    ]);
  });

  it("keeps JSON and Markdown packages bounded and importable", () => {
    const preferences = {
      ...DEFAULT_SIGNAL_PREFERENCES,
      defaultFilter: "attention" as const,
      compactMode: true,
      voiceMode: "queue-preview" as const,
      voicePreset: "calm" as const,
      voiceRate: 1.2 as const,
      voicePriority: "high-or-urgent" as const,
    };
    const json = serializeSignalPreferences(preferences, "json");
    const markdown = serializeSignalPreferences(preferences, "markdown");
    expect(parseSignalPreferences(json, "json")).toMatchObject({ defaultFilter: "attention", compactMode: true, voiceMode: "queue-preview", voicePreset: "calm", voiceRate: 1.2, voicePriority: "high-or-urgent" });
    expect(parseSignalPreferences(markdown, "markdown")).toMatchObject({ defaultFilter: "attention", compactMode: true, voiceMode: "queue-preview", voicePreset: "calm", voiceRate: 1.2, voicePriority: "high-or-urgent" });
    expect(json).toContain("omnia.signal-preferences.preview.v1");
    expect(markdown).toContain("Renderer-local preview only");
  });

  it("keeps undo/reset session-local", () => {
    updateSignalPreferences({ compactMode: true });
    expect(getSignalPreferencesSession().present.compactMode).toBe(true);
    undoSignalPreferences();
    expect(getSignalPreferencesSession().present.compactMode).toBe(false);
    updateSignalPreferences({ compactMode: true });
    resetSignalPreferences();
    expect(getSignalPreferencesSession().present).toEqual(DEFAULT_SIGNAL_PREFERENCES);
  });
});
