import { describe, expect, it } from "vitest";
import {
  createInMemorySettingsPermissionsAdapter,
  createSettingsPermissionsSnapshot,
  normalizeSettingsPermissionsSnapshot,
  OmniaSettingsPermissionsAdapter,
  serializeSettingsPermissionsSnapshot,
  SettingsPermissionsError,
  updateSettingsPermissionsSnapshot,
} from "./omnia-settings-permissions-adapter";

describe("Omnia settings/permissions adapter", () => {
  it("round-trips settings and evaluates the permission policy", async () => {
    const initial = createSettingsPermissionsSnapshot({ values: { theme: "graphite", reducedMotion: true } });
    const adapter = createInMemorySettingsPermissionsAdapter(initial);

    const loaded = await adapter.load();
    expect(loaded.status).toBe("loaded");
    if (loaded.status !== "loaded") return;
    expect(loaded.snapshot.settings.values.theme).toBe("graphite");
    expect(adapter.evaluate(loaded.snapshot, "write-workspace", "workspace")).toBe("ask");

    const next = updateSettingsPermissionsSnapshot(loaded.snapshot, { values: { theme: "slate" } });
    const saved = await adapter.save(next, loaded.revision);
    expect(saved.revision).toBe(2);
  });

  it("rejects stale compare-and-swap writes", async () => {
    const adapter = createInMemorySettingsPermissionsAdapter(createSettingsPermissionsSnapshot());
    const loaded = await adapter.load();
    if (loaded.status !== "loaded") throw new Error("expected loaded snapshot");
    const next = updateSettingsPermissionsSnapshot(loaded.snapshot, { values: { compact: true } });
    await expect(adapter.save(next, loaded.revision + 1)).rejects.toMatchObject({ kind: "revision-conflict" } satisfies Partial<SettingsPermissionsError>);
  });

  it("rejects unsafe settings keys", () => {
    expect(() => createSettingsPermissionsSnapshot({ values: { ["__proto__"]: true } })).toThrow(/safe/);
  });

  it("returns an empty result before the first in-memory save", async () => {
    const adapter = createInMemorySettingsPermissionsAdapter();

    await expect(adapter.load()).resolves.toMatchObject({
      status: "empty",
      backend: "memory",
      durable: false,
    });
  });

  it("preserves nested JSON-safe values and clones the input", () => {
    const values = {
      editor: {
        fontSize: 14,
        tabs: ["one", "two"],
        flags: { ligatures: true, experimental: null },
      },
    } as const;
    const snapshot = createSettingsPermissionsSnapshot({ values });

    expect(snapshot.settings.values).toEqual(values);
    expect(snapshot.settings.values).not.toBe(values);
    expect(snapshot.settings.values.editor).not.toBe(values.editor);
  });

  it.each([
    ["not-json", /not valid JSON/],
    [{ version: 1 }, /Invalid Omnia settings\/permissions snapshot/],
    [{ version: 1, settings: {}, permissions: {} }, /Invalid permission policy/],
  ] as const)("rejects malformed snapshot input: %s", (input, message) => {
    expect(() => normalizeSettingsPermissionsSnapshot(input)).toThrow(message);
  });

  it("rejects snapshots whose top-level revision does not cover a child", () => {
    const snapshot = createSettingsPermissionsSnapshot({ now: "2026-01-01T00:00:00.000Z" });

    expect(() => normalizeSettingsPermissionsSnapshot({ ...snapshot, revision: 0 })).toThrow(/positive integer/);
    expect(() => normalizeSettingsPermissionsSnapshot({
      ...snapshot,
      revision: snapshot.settings.revision,
      settings: { ...snapshot.settings, revision: snapshot.settings.revision + 1 },
    })).toThrow(/cover nested revisions/);
  });

  it("rejects invalid values, timestamps, revisions, and nested unsafe keys", () => {
    const snapshot = createSettingsPermissionsSnapshot({ now: "2026-01-01T00:00:00.000Z" });

    expect(() => normalizeSettingsPermissionsSnapshot({
      ...snapshot,
      updatedAt: "not-a-date",
    })).toThrow(/timestamp/);
    expect(() => normalizeSettingsPermissionsSnapshot({
      ...snapshot,
      settings: { ...snapshot.settings, values: { editor: { ["constructor"]: true } } },
    })).toThrow(/safe/);
    expect(() => normalizeSettingsPermissionsSnapshot({
      ...snapshot,
      settings: { ...snapshot.settings, values: { fontSize: Number.POSITIVE_INFINITY } },
    })).toThrow(/finite/);
  });

  it("increments the snapshot revision when settings or permissions change", () => {
    const initial = createSettingsPermissionsSnapshot({ now: "2026-01-01T00:00:00.000Z" });
    const changedSettings = updateSettingsPermissionsSnapshot(initial, { values: { theme: "slate" } }, "2026-01-01T00:00:01.000Z");
    const changedPermissions = updateSettingsPermissionsSnapshot(changedSettings, { permissions: {
      ...changedSettings.permissions,
      revision: changedSettings.permissions.revision + 1,
      updatedAt: "2026-01-01T00:00:02.000Z",
      preset: "custom",
      rules: [],
    } }, "2026-01-01T00:00:02.000Z");

    expect(changedSettings.revision).toBe(initial.revision + 1);
    expect(changedSettings.settings.revision).toBe(initial.settings.revision + 1);
    expect(changedPermissions.revision).toBeGreaterThan(changedSettings.revision);
    expect(changedPermissions.permissions.preset).toBe("custom");
  });

  it("maps exact and global permission rules through evaluate", () => {
    const snapshot = createSettingsPermissionsSnapshot({ permissions: {
      version: 1,
      id: "custom-policy",
      name: "Custom",
      preset: "custom",
      revision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      rules: [
        { capability: "write-workspace", scope: "global", effect: "deny" },
        { capability: "write-workspace", scope: "workspace", effect: "allow" },
      ],
    } });
    const adapter = createInMemorySettingsPermissionsAdapter(snapshot);

    expect(adapter.evaluate(snapshot, "write-workspace", "workspace")).toBe("allow");
    expect(adapter.evaluate(snapshot, "write-workspace", "project")).toBe("deny");
    expect(adapter.evaluate(snapshot, "use-network", "session")).toBe("ask");
  });

  it("propagates load metadata and enforces minimumRevision", async () => {
    const snapshot = createSettingsPermissionsSnapshot();
    const port = {
      backend: "native" as const,
      durable: true,
      load: async () => ({ status: "loaded" as const, snapshot: serializeSettingsPermissionsSnapshot(snapshot), revision: snapshot.revision, receiptId: "load-1" }),
      save: async () => ({ status: "saved" as const, revision: snapshot.revision, receiptId: "save-1" }),
    };
    const adapter = new OmniaSettingsPermissionsAdapter(port);

    await expect(adapter.load({ minimumRevision: snapshot.revision })).resolves.toMatchObject({
      status: "loaded",
      backend: "native",
      durable: true,
      receiptId: "load-1",
    });
    await expect(adapter.load({ minimumRevision: snapshot.revision + 1 })).rejects.toMatchObject({
      kind: "revision-conflict",
      retryable: true,
      details: { minimumRevision: snapshot.revision + 1, revision: snapshot.revision },
    } satisfies Partial<SettingsPermissionsError>);
  });

  it("rejects a load response with a mismatched native revision", async () => {
    const snapshot = createSettingsPermissionsSnapshot();
    const adapter = new OmniaSettingsPermissionsAdapter({
      load: async () => ({ status: "loaded" as const, snapshot, revision: snapshot.revision + 1 }),
      save: async () => ({ status: "saved" as const, revision: snapshot.revision }),
    });

    await expect(adapter.load()).rejects.toMatchObject({
      kind: "persistence-failure",
      retryable: false,
    } satisfies Partial<SettingsPermissionsError>);
  });

  it("maps native unavailable and generic port failures", async () => {
    const snapshot = createSettingsPermissionsSnapshot();
    const unavailable = new OmniaSettingsPermissionsAdapter({
      load: async () => { throw { code: "native_unavailable" }; },
      save: async () => { throw { code: "native_unavailable" }; },
    });
    const generic = new OmniaSettingsPermissionsAdapter({
      load: async () => { throw new Error("disk full"); },
      save: async () => { throw new Error("disk full"); },
    });

    await expect(unavailable.load()).rejects.toMatchObject({ kind: "unavailable", retryable: true, details: { code: "native_unavailable" } });
    await expect(unavailable.save(snapshot)).rejects.toMatchObject({ kind: "unavailable", retryable: true, details: { code: "native_unavailable" } });
    await expect(generic.load()).rejects.toMatchObject({ kind: "persistence-failure", retryable: false });
    await expect(generic.save(snapshot)).rejects.toMatchObject({ kind: "persistence-failure", retryable: false });
  });

  it("maps CAS conflicts and guards against a native revision regression on save", async () => {
    const snapshot = createSettingsPermissionsSnapshot();
    const conflict = new OmniaSettingsPermissionsAdapter({
      load: async () => ({ status: "empty" as const }),
      save: async () => ({ status: "conflict" as const, currentRevision: 4, expectedRevision: 3, receiptId: "conflict-1" }),
    });
    const regressed = new OmniaSettingsPermissionsAdapter({
      load: async () => ({ status: "empty" as const }),
      save: async () => ({ status: "saved" as const, revision: snapshot.revision - 1 }),
    });

    await expect(conflict.save(snapshot, 3)).rejects.toMatchObject({
      kind: "revision-conflict",
      retryable: true,
      details: { currentRevision: 4, expectedRevision: 3 },
    } satisfies Partial<SettingsPermissionsError>);
    await expect(regressed.save(snapshot)).rejects.toMatchObject({
      kind: "persistence-failure",
      retryable: false,
    } satisfies Partial<SettingsPermissionsError>);
  });

  it("validates the requested expected revision before calling the port", async () => {
    const snapshot = createSettingsPermissionsSnapshot();
    let calls = 0;
    const adapter = new OmniaSettingsPermissionsAdapter({
      load: async () => ({ status: "empty" as const }),
      save: async () => { calls += 1; return { status: "saved" as const, revision: snapshot.revision }; },
    });

    await expect(adapter.save(snapshot, 0)).rejects.toMatchObject({ kind: "invalid-snapshot", retryable: false });
    expect(calls).toBe(0);
  });
});
