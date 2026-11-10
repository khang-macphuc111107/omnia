import { describe, expect, it } from "vitest";
import {
  appendPointerAction,
  createInMemoryPointerSessionStorage,
  createPointerSession,
  parsePointerSession,
  serializePointerSession,
  transitionPointerSession,
} from "./virtual-pointer";

const binding = {
  targetId: "target-1",
  targetKind: "browser-tab" as const,
  targetGeneration: 2,
  targetScopeHash: "scope-hash",
  browserContextId: "ctx-1",
  browserTargetId: "tab-1",
  frameId: "frame-1",
  documentEpoch: "doc-1",
};
const base = () => createPointerSession({
  pointerId: "pointer-1",
  ownerRunId: "run-1",
  targetBinding: binding,
  transport: "browser-cdp",
  coordinateSpace: "browser-viewport",
  containment: { kind: "target-surface", width: 800, height: 600, transformRevision: 3, transformId: "transform-3" },
  createdAt: "2026-11-07T00:00:00.000Z",
});

describe("virtual pointer domain", () => {
  it("keeps a pointer target-bound and rejects coordinates outside containment", () => {
    expect(() => createPointerSession({
      pointerId: "pointer-1", ownerRunId: "run-1", targetBinding: binding,
      transport: "browser-cdp", coordinateSpace: "browser-viewport",
      position: { x: 801, y: 2, coordinateSpace: "browser-viewport" },
      containment: { kind: "target-surface", width: 800, height: 600, transformRevision: 3, transformId: "transform-3" },
      createdAt: "2026-11-07T00:00:00.000Z",
    })).toThrow(/inside target containment/);
  });

  it("rejects stale target generations and transforms", () => {
    const ready = transitionPointerSession(base(), "ready", "2026-11-07T00:00:01.000Z");
    expect(() => appendPointerAction(ready, {
      id: "action-1", kind: "click-coordinate", transformRevision: 2,
      position: { x: 12, y: 20, coordinateSpace: "browser-viewport" },
      requestedAt: "2026-11-07T00:00:02.000Z",
    }, "2026-11-07T00:00:02.000Z")).toThrow(/stale coordinate transform/);
    expect(() => appendPointerAction(ready, {
      id: "action-2", kind: "click-coordinate", targetBinding: { ...binding, targetGeneration: 1 },
      position: { x: 12, y: 20, coordinateSpace: "browser-viewport" },
      requestedAt: "2026-11-07T00:00:02.000Z",
    }, "2026-11-07T00:00:02.000Z")).toThrow(/stale or outside/);
  });

  it("round-trips action history and enforces CAS storage", async () => {
    const ready = transitionPointerSession(base(), "ready", "2026-11-07T00:00:01.000Z");
    const session = appendPointerAction(ready, { id: "action-1", kind: "click-coordinate", position: { x: 12, y: 20, coordinateSpace: "browser-viewport" }, requestedAt: "2026-11-07T00:00:02.000Z" }, "2026-11-07T00:00:02.000Z");
    expect(parsePointerSession(JSON.parse(serializePointerSession(session)))).toEqual(session);
    const storage = createInMemoryPointerSessionStorage();
    await expect(storage.save(session, 0)).resolves.toMatchObject({ status: "saved", revision: 2 });
    await expect(storage.save(session, 0)).resolves.toMatchObject({ status: "conflict", currentRevision: 2 });
    expect(await storage.load("pointer-1")).toEqual(session);
  });

  it("never appends after close", () => {
    const closed = transitionPointerSession(base(), "close", "2026-11-07T00:00:01.000Z");
    expect(() => appendPointerAction(closed, { id: "action-1", kind: "stop" }, "2026-11-07T00:00:02.000Z")).toThrow(/closed/);
  });
});