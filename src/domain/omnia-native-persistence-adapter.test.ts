import { describe, expect, it } from "vitest";

import { createOmniaAppState, updateOmniaAppState } from "./omnia-app-state";
import {
  createInMemoryOmniaPersistenceAdapter,
  OmniaNativePersistenceAdapter,
  OmniaPersistenceError,
  type OmniaNativePersistencePort,
} from "./omnia-native-persistence-adapter";
import {
  createOmniaTransferBundle,
  createOmniaTransferItem,
} from "./omnia-data-transfer";

const now = "2026-10-17T00:00:00.000Z";
const later = "2026-10-17T00:01:00.000Z";

describe("Omnia native persistence adapter", () => {
  it("round-trips through the in-memory port without retaining object references", async () => {
    const adapter = createInMemoryOmniaPersistenceAdapter();
    const initial = createOmniaAppState(now);

    expect((await adapter.health()).durable).toBe(false);
    expect((await adapter.loadSnapshot()).status).toBe("empty");

    const save = await adapter.saveSnapshot(initial);
    expect(save.status).toBe("saved");
    expect(save.revision).toBe(initial.revision);

    const loaded = await adapter.loadSnapshot();
    expect(loaded.status).toBe("loaded");
    if (loaded.status !== "loaded") return;
    expect(loaded.state).toEqual(initial);

    // Mutating either side after the IPC boundary must not mutate the other.
    (initial.editor as { title: string }).title = "changed after save";
    (loaded.state.editor as { title: string }).title = "changed after load";
    const loadedAgain = await adapter.loadSnapshot();
    expect(loadedAgain.status).toBe("loaded");
    if (loadedAgain.status === "loaded") {
      expect(loadedAgain.state.editor.title).toBe("Untitled");
    }
  });

  it("rejects stale compare-and-swap writes with a typed conflict", async () => {
    const adapter = createInMemoryOmniaPersistenceAdapter();
    const first = createOmniaAppState(now);
    await adapter.saveSnapshot(first);

    const next = updateOmniaAppState(first, {}, later);
    await expect(adapter.saveSnapshot(next, { expectedRevision: first.revision })).resolves.toMatchObject({
      revision: next.revision,
    });

    const stale = updateOmniaAppState(first, {}, later);
    await expect(adapter.saveSnapshot(stale, { expectedRevision: first.revision })).rejects.toMatchObject({
      kind: "revision-conflict",
    });
  });

  it("classifies malformed native snapshots separately from transport failures", async () => {
    const malformedPort: OmniaNativePersistencePort = {
      backend: "native",
      durable: true,
      loadSnapshot: async () => ({ status: "loaded", snapshot: "{}", revision: 1 }),
      saveSnapshot: async () => ({ status: "saved", revision: 1 }),
    };
    const adapter = new OmniaNativePersistenceAdapter(malformedPort);

    try {
      await adapter.loadSnapshot();
      throw new Error("Expected malformed snapshot rejection.");
    } catch (error) {
      expect(error).toBeInstanceOf(OmniaPersistenceError);
      expect((error as OmniaPersistenceError).kind).toBe("invalid-snapshot");
    }
  });

  it("validates transfer bundles at both sides of the adapter boundary", async () => {
    const adapter = createInMemoryOmniaPersistenceAdapter();
    const bundle = createOmniaTransferBundle({
      bundleId: "bundle-test",
      createdAt: now,
      items: [
        createOmniaTransferItem({
          kind: "custom",
          id: "record-1",
          updatedAt: now,
          value: { value: "portable" },
        }),
      ],
    });

    const exported = await adapter.exportTransferBundle(bundle);
    expect(exported.bundle).toEqual(bundle);
    const imported = await adapter.importTransferBundle(JSON.stringify(bundle));
    expect(imported.bundle).toEqual(bundle);

    await expect(adapter.importTransferBundle("not-json")).rejects.toMatchObject({
      kind: "invalid-transfer",
    });
  });
});
