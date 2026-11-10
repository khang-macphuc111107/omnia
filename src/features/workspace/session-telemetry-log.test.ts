import { describe, expect, it, vi } from "vitest";

import {
  appendSessionTelemetryEntry,
  DEFAULT_SESSION_TELEMETRY_LIMIT,
  MAX_SESSION_TELEMETRY_LIMIT,
  SessionTelemetryLog,
} from "./session-telemetry-log";

const now = new Date("2026-10-01T08:00:00.000Z");

describe("SessionTelemetryLog", () => {
  it("records a redacted allowlist and drops untrusted extra fields", () => {
    const log = new SessionTelemetryLog({ now: () => now, idPrefix: "settings / preview" });
    const unsafe = {
      id: "event-unsafe",
      level: "warning" as const,
      category: "provider" as const,
      title: "Provider response for dev@example.test",
      detail: "Authorization: Bearer sk-preview-secret-123456789 file:///C:/Users/khang/private.txt",
      source: "provider-preview",
      headers: { authorization: "Bearer raw-secret" },
      rawPayload: "must-not-cross-the-buffer",
    };

    const event = log.append(unsafe);

    expect(event).toEqual({
      id: "event-unsafe",
      occurredAt: now.toISOString(),
      level: "warning",
      category: "provider",
      title: "Provider response for [REDACTED_EMAIL]",
      detail: "Authorization: [REDACTED_CREDENTIAL] file:///[REDACTED_PATH]",
      source: "provider-preview",
    });
    expect(event).not.toHaveProperty("headers");
    expect(event).not.toHaveProperty("rawPayload");
    expect(JSON.stringify(log.snapshot())).not.toContain("sk-preview-secret-123456789");
  });

  it("keeps the newest entries first and enforces a small in-memory bound", () => {
    const log = new SessionTelemetryLog({ maxEntries: 2, now: () => now });

    log.append({ level: "info", category: "runtime", title: "First", source: "test" });
    log.append({ level: "info", category: "runtime", title: "Second", source: "test" });
    log.append({ level: "info", category: "runtime", title: "Third", source: "test" });

    expect(log.size).toBe(2);
    expect(log.snapshot().map((event) => event.title)).toEqual(["Third", "Second"]);
    expect(log.snapshot()).toBeInstanceOf(Array);
  });

  it("supports batch append, immutable snapshots, and clear without durable side effects", () => {
    const log = new SessionTelemetryLog({ now: () => now });
    const result = log.appendMany([
      { level: "info", category: "navigation", title: "Opened settings", source: "test" },
      { level: "success", category: "runtime", title: "Ready", source: "test" },
    ]);
    const snapshot = log.snapshot();

    expect(result).toHaveLength(2);
    expect(snapshot.map((event) => event.title)).toEqual(["Ready", "Opened settings"]);
    expect(() => {
      (snapshot as unknown as Array<unknown>).push("not an event");
    }).toThrow();

    log.clear();
    expect(log.size).toBe(0);
    expect(log.snapshot()).toEqual([]);
  });

  it("generates bounded IDs and validates configured limits", () => {
    const log = new SessionTelemetryLog({ now: () => now, idPrefix: "unsafe prefix / token" });
    const event = log.append({ level: "info", category: "runtime", title: "Ready", source: "test" });

    expect(event.id).toMatch(/^unsafe-prefix---token-1$/);
    expect(() => new SessionTelemetryLog({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new SessionTelemetryLog({ maxEntries: MAX_SESSION_TELEMETRY_LIMIT + 1 })).toThrow(RangeError);
    expect(DEFAULT_SESSION_TELEMETRY_LIMIT).toBeGreaterThan(0);
  });

  it("offers a pure bounded append for reducer-style callers", () => {
    const first = appendSessionTelemetryEntry([], {
      level: "info",
      category: "composer",
      title: "Composer opened",
      source: "test",
    }, { now: () => now, sequence: 7, idPrefix: "pure" });
    const second = appendSessionTelemetryEntry(first, {
      level: "error",
      category: "storage",
      title: "Storage unavailable",
      source: "test",
    }, { now: () => now, sequence: 8, idPrefix: "pure", maxEntries: 1 });

    expect(first).toHaveLength(1);
    expect(first[0]?.id).toBe("pure-7");
    expect(second.map((event) => event.title)).toEqual(["Storage unavailable"]);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it("never writes to the console while recording", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = new SessionTelemetryLog({ now: () => now });

    log.append({ level: "error", category: "runtime", title: "Failure", source: "test" });

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
