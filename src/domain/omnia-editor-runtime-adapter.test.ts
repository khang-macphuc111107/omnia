import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import {
  applyEditorRuntimeChange,
  createEditorRuntime,
  createMemoryEditorPersistenceAdapter,
  deserializeEditorRuntime,
  OmniaEditorRuntimeAdapter,
  openEditorRuntime,
  persistEditorRuntime,
  redoEditorRuntimeChange,
  serializeEditorRuntime,
  undoEditorRuntimeChange,
  validateEditorRuntimeDocument,
} from "./omnia-editor-runtime-adapter";
import { createEditorDocument } from "./omnia-editor-model";

const now = "2026-10-17T00:00:00.000Z";
const later = "2026-10-17T00:01:00.000Z";
const latest = "2026-10-17T00:02:00.000Z";

describe("editor runtime adapter", () => {
  it("creates, saves, and reopens a missing document through the memory adapter", async () => {
    const adapter = createMemoryEditorPersistenceAdapter([], { now: () => later });
    const state = await openEditorRuntime(adapter, "doc-open", {
      createIfMissing: true,
      title: "Draft",
      now,
    });

    expect(state.document.id).toBe("doc-open");
    expect(state.document.title).toBe("Draft");
    expect(state.status).toBe("ready");
    expect(state.persistedRevision).toBe(0);

    const saved = await persistEditorRuntime(state, adapter, { now: later });
    expect(saved.receipt.revision).toBe(1);
    expect(saved.state.status).toBe("ready");
    expect(saved.state.persistedRevision).toBe(1);

    const reopened = await openEditorRuntime(adapter, "doc-open", { createIfMissing: false, now: latest });
    expect(reopened.document).toEqual(saved.receipt.document);
    expect(reopened.persistedRevision).toBe(1);
    expect(reopened.openedAt).toBe(latest);
  });

  it("applies document edits and maintains undo/redo history", () => {
    const state = createEditorRuntime(createEditorDocument("Draft", now), { now });
    const blockId = state.document.blocks[0]?.id;
    expect(blockId).toBeDefined();
    if (!blockId) return;

    const titled = applyEditorRuntimeChange(state, { type: "set-title", title: "Renamed" }, later);
    const edited = applyEditorRuntimeChange(
      titled,
      { type: "update-block", blockId, patch: { text: "hello" } },
      latest,
    );
    expect(edited.status).toBe("dirty");
    expect(edited.revision).toBe(2);
    expect(edited.document.title).toBe("Renamed");
    expect(edited.document.blocks[0]?.text).toBe("hello");

    const undone = undoEditorRuntimeChange(edited, latest);
    expect(undone.document.blocks[0]?.text).toBe("");
    expect(undone.document.title).toBe("Renamed");
    expect(undone.revision).toBe(3);

    const redone = redoEditorRuntimeChange(undone, latest);
    expect(redone.document.blocks[0]?.text).toBe("hello");
    expect(redone.revision).toBe(4);
  });

  it("validates selections, duplicate blocks, and timestamp updates", () => {
    const state = createEditorRuntime(createEditorDocument("Draft", now), { now });
    const block = state.document.blocks[0];
    expect(block).toBeDefined();
    if (!block) return;

    const selected = applyEditorRuntimeChange(
      state,
      { type: "set-selection", selection: { blockId: block.id, start: 0, end: 0 } },
      later,
    );
    expect(selected.document.selection).toEqual({ blockId: block.id, start: 0, end: 0 });
    expect(selected.document.updatedAt).toBe(later);

    expect(() =>
      validateEditorRuntimeDocument({
        ...state.document,
        blocks: [block, { ...block }],
      }),
    ).toThrowError(DomainError);

    expect(() =>
      applyEditorRuntimeChange(state, {
        type: "set-selection",
        selection: { blockId: "missing", start: 0, end: 0 },
      }),
    ).toThrowError(DomainError);
  });

  it("rejects dirty close without explicit discard and keeps a closed facade closed", () => {
    const facade = new OmniaEditorRuntimeAdapter(createMemoryEditorPersistenceAdapter());
    const state = facade.create(createEditorDocument("Draft", now), { now });
    const blockId = state.document.blocks[0]?.id;
    expect(blockId).toBeDefined();
    if (!blockId) return;

    facade.apply({ type: "update-block", blockId, patch: { text: "unsaved" } }, later);
    expect(() => facade.close()).toThrowError(DomainError);

    const closed = facade.close({ discardChanges: true, now: latest });
    expect(closed.status).toBe("closed");
    expect(() => facade.apply({ type: "set-title", title: "nope" })).toThrowError(DomainError);
    expect(facade.state?.status).toBe("closed");
  });

  it("enforces optimistic revision checks between concurrent runtimes", async () => {
    const adapter = createMemoryEditorPersistenceAdapter([], { now: () => later });
    const first = await openEditorRuntime(adapter, "shared", { createIfMissing: true, now });
    const firstSaved = await persistEditorRuntime(first, adapter, { now: later });
    const second = await openEditorRuntime(adapter, "shared", { createIfMissing: false, now: latest });

    const firstDirty = applyEditorRuntimeChange(firstSaved.state, { type: "set-title", title: "first" }, latest);
    await persistEditorRuntime(firstDirty, adapter, { now: latest });

    const secondDirty = applyEditorRuntimeChange(second, { type: "set-title", title: "stale" }, latest);
    await expect(persistEditorRuntime(secondDirty, adapter)).rejects.toMatchObject({ code: "conflict" });
  });

  it("round-trips a runtime snapshot without losing history", () => {
    const state = createEditorRuntime(createEditorDocument("Draft", now), { now });
    const changed = applyEditorRuntimeChange(state, { type: "set-title", title: "Renamed" }, later);
    const encoded = serializeEditorRuntime(changed);
    const decoded = deserializeEditorRuntime(encoded);

    expect(decoded).toEqual(changed);
    expect(decoded.history.past).toHaveLength(1);
    expect(decoded.history.present.title).toBe("Renamed");
  });

  it("emits renderer-safe lifecycle events from the stateful facade", async () => {
    const facade = new OmniaEditorRuntimeAdapter(createMemoryEditorPersistenceAdapter([], { now: () => later }));
    const events: string[] = [];
    facade.subscribe((event) => events.push(event.type));

    facade.create(createEditorDocument("Draft", now), { now });
    facade.apply({ type: "set-title", title: "Renamed" }, later);
    await facade.save({ now: later });
    facade.close({ now: latest });

    expect(events).toEqual(["opened", "changed", "saved", "closed"]);
  });
});
