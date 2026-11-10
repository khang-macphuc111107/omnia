import { describe, expect, it, vi } from "vitest";

import { createBrowserSessionNavigationPort, EMPTY_SESSION_NAVIGATION, SessionNavigationClient, validateSessionNavigation, validateSessionNavigationReceiptId, type SessionNavigationPort, type SessionNavigationSaveRequest, type SessionNavigationSnapshot } from "./session-navigation";

function snapshot(revision: number, openIds: string[] = [], activeId: string | null = null): SessionNavigationSnapshot {
  return { schemaVersion: 1, revision, openIds, activeId, updatedAtMs: revision ? 1 : 0 };
}

function portFor(initial: SessionNavigationSnapshot = EMPTY_SESSION_NAVIGATION) {
  let stored = initial;
  const saves: SessionNavigationSaveRequest[] = [];
  const port: SessionNavigationPort = {
    load: async () => ({ snapshot: stored, receiptId: "load" }),
    save: async (request) => {
      saves.push(request);
      if (request.expectedRevision !== stored.revision) return { status: "conflict", snapshot: stored, receiptId: "conflict" };
      stored = snapshot(stored.revision + 1, [...request.openIds], request.activeId);
      return { status: "saved", snapshot: stored, receiptId: "save" };
    },
  };
  return { port, saves, stored: () => stored, replace: (value: SessionNavigationSnapshot) => { stored = value; } };
}

describe("session navigation persistence", () => {
  it("returns a stable browser receipt for the same persisted revision", async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
    const port = createBrowserSessionNavigationPort(storage);
    const empty = await port.load();
    expect(empty.receiptId).toBe("browser-session-navigation-empty");
    const saved = await port.save({ expectedRevision: 0, openIds: ["a"], activeId: "a" });
    expect((await port.load()).receiptId).toBe(saved.receiptId);
    expect((await port.save({ expectedRevision: 0, openIds: [], activeId: null })).receiptId).toBe(saved.receiptId);
  });

  it("fails closed on malformed receipt IDs from a native port", async () => {
    expect(() => validateSessionNavigationReceiptId(" ")).toThrow();
    const client = new SessionNavigationClient({
      load: async () => ({ snapshot: EMPTY_SESSION_NAVIGATION, receiptId: "bad\u0000receipt" }),
      save: async () => ({ status: "saved", snapshot: snapshot(1, ["a"], "a"), receiptId: "save" }),
    });
    await expect(client.start()).rejects.toThrow(/receipt/i);
  });

  it("restores native tab order and preserves clicks made during hydration", async () => {
    const store = portFor(snapshot(7, ["b", "a"], "a"));
    let resolveLoad!: (response: Awaited<ReturnType<SessionNavigationPort["load"]>>) => void;
    store.port.load = () => new Promise((resolve) => { resolveLoad = resolve; });
    const client = new SessionNavigationClient(store.port);
    const loading = client.start();
    client.select("c");
    resolveLoad({ snapshot: store.stored(), receiptId: "load" });
    await loading;
    expect(client.snapshot.openIds).toEqual(["b", "a", "c"]);
    expect(client.snapshot.activeId).toBe("c");
    expect(store.saves[0]?.expectedRevision).toBe(7);
    expect(client.snapshot.revision).toBe(8);
  });

  it("serializes concurrent edits and rebases them on another window's accepted revision", async () => {
    const store = portFor(snapshot(2, ["a"], "a"));
    const client = new SessionNavigationClient(store.port);
    await client.start();
    store.replace(snapshot(3, ["a", "remote"], "remote"));
    client.select("b");
    client.select("c");
    await client.flush();
    expect(store.stored().openIds).toEqual(["a", "remote", "b", "c"]);
    expect(store.stored().activeId).toBe("c");
    expect(store.saves.map((entry) => entry.expectedRevision)).toEqual([2, 3]);
  });

  it("closes views without deleting sessions and reaches the home view when the last tab closes", async () => {
    const store = portFor(snapshot(1, ["b", "a"], "a"));
    const client = new SessionNavigationClient(store.port);
    await client.start();
    client.close("a");
    expect(client.snapshot).toMatchObject({ openIds: ["b"], activeId: "b" });
    client.close("b");
    await client.flush();
    expect(store.stored()).toMatchObject({ openIds: [], activeId: null });
    client.select("a");
    await client.flush();
    expect(store.stored()).toMatchObject({ openIds: ["a"], activeId: "a" });
  });

  it("prunes deleted IDs, retains the default home selection and never loads transcripts", async () => {
    const store = portFor(snapshot(2, ["b", "a", "deleted"], "b"));
    const client = new SessionNavigationClient(store.port);
    client.select(null);
    client.prune(new Set(["a", "b"]));
    await client.start();
    expect(store.stored()).toMatchObject({ openIds: ["b", "a"], activeId: null });
  });

  it("does not write after failed hydration and can retry without losing local changes", async () => {
    const store = portFor(snapshot(4, ["a"], "a"));
    const load = vi.fn(store.port.load).mockRejectedValueOnce(new Error("storage unavailable"));
    store.port.load = load;
    const client = new SessionNavigationClient(store.port);
    client.select("b");
    await expect(client.start()).rejects.toThrow("storage unavailable");
    expect(store.saves).toHaveLength(0);
    expect(client.snapshot.openIds).toEqual(["b"]);
    await client.start();
    expect(client.snapshot.openIds).toEqual(["a", "b"]);
  });

  it("keeps edits local when a save fails and validates immutable boundary metadata", async () => {
    const store = portFor(snapshot(1, ["a"], "a"));
    const save = vi.fn(store.port.save).mockRejectedValueOnce(new Error("write failed"));
    store.port.save = save;
    const errors = vi.fn();
    const client = new SessionNavigationClient(store.port, errors);
    await client.start();
    client.select("b");
    await expect(client.flush()).rejects.toThrow("write failed");
    expect(client.snapshot.openIds).toEqual(["a", "b"]);
    await client.flush();
    expect(store.stored().openIds).toEqual(["a", "b"]);
    const frozen = validateSessionNavigation(snapshot(2, ["a"], "a"));
    expect(Object.isFrozen(frozen.openIds)).toBe(true);
    for (const invalid of [snapshot(1, ["a", "a"]), snapshot(1, [" a"]), snapshot(1, ["a"], "b"), { ...snapshot(1), revision: NaN }]) {
      expect(() => validateSessionNavigation(invalid)).toThrow();
    }
  });
});
