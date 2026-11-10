import { describe, expect, it } from "vitest";

import {
  createOmniaAppState,
  deserializeOmniaAppState,
  migrateOmniaAppState,
  serializeOmniaAppState,
} from "./omnia-app-state";

const now = "2026-10-17T00:00:00.000Z";

function recordFromState(): Record<string, unknown> {
  return JSON.parse(serializeOmniaAppState(createOmniaAppState(now))) as Record<string, unknown>;
}

describe("Omnia app-state migrations", () => {
  it("upgrades an unversioned legacy envelope without mutating the caller", () => {
    const legacy = recordFromState();
    delete legacy.version;
    delete legacy.featureFlags;
    delete legacy.automation;
    delete legacy.events;
    const before = JSON.stringify(legacy);

    const migration = migrateOmniaAppState(legacy);

    expect(migration).toMatchObject({
      fromVersion: 0,
      toVersion: 1,
      migrated: true,
    });
    expect(migration.appliedMigrations).toEqual([
      "app-state-v0-envelope",
      "feature-flags-default",
      "automation-default",
      "event-log-default",
    ]);
    expect(migration.value.version).toBe(1);
    expect(JSON.stringify(legacy)).toBe(before);
    expect(deserializeOmniaAppState(legacy)).toMatchObject({
      version: 1,
      revision: 1,
      updatedAt: now,
    });
  });

  it("keeps the existing v1 compatibility defaults for optional surfaces", () => {
    const legacy = recordFromState();
    delete legacy.featureFlags;
    delete legacy.automation;

    const migration = migrateOmniaAppState(legacy);
    expect(migration.fromVersion).toBe(1);
    expect(migration.appliedMigrations).toEqual([
      "feature-flags-default",
      "automation-default",
    ]);
    expect(deserializeOmniaAppState(legacy).events.events).toEqual([]);
  });

  it("does not silently accept a malformed present-day envelope or a future version", () => {
    const missingEvents = recordFromState();
    delete missingEvents.events;
    expect(() => deserializeOmniaAppState(missingEvents)).toThrow("Invalid Omnia app state payload.");

    const future = recordFromState();
    future.version = 2;
    expect(() => migrateOmniaAppState(future)).toThrow("Unsupported Omnia app state version: 2.");
  });
});
