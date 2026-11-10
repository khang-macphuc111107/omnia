import { afterEach, describe, expect, it, vi } from "vitest";

import { desktop, type RunStreamEvent } from "@/lib/desktop";

import { startRunEventJournalBuffer, stopRunEventJournalBuffer, subscribeRunEvents } from "./run-event-broker";

afterEach(() => {
  stopRunEventJournalBuffer();
  vi.restoreAllMocks();
  delete window.__TAURI_INTERNALS__;
});

describe("shared full-window native run projections", () => {
  it("projects once and retains the workspace owner when the same panel callback unmounts", async () => {
    window.__TAURI_INTERNALS__ = {} as Window["__TAURI_INTERNALS__"];
    let emit: ((event: RunStreamEvent) => void) | undefined;
    const nativeUnlisten = vi.fn();
    const onRunEvent = vi.spyOn(desktop, "onRunEvent").mockImplementation(async (listener) => {
      emit = listener;
      return nativeUnlisten;
    });
    const projection = vi.fn();
    const workspaceUnsubscribe = subscribeRunEvents(projection);
    const panelUnsubscribe = subscribeRunEvents(projection);
    await startRunEventJournalBuffer();
    expect(onRunEvent).toHaveBeenCalledTimes(1);
    const event: RunStreamEvent = { type: "delta", runId: "run_full_window", sequence: 1, text: "one native chunk" };
    emit?.(event);
    expect(projection).toHaveBeenCalledTimes(1);

    panelUnsubscribe();
    panelUnsubscribe();
    emit?.(event);
    expect(projection).toHaveBeenCalledTimes(2);
    workspaceUnsubscribe();
    emit?.(event);
    expect(projection).toHaveBeenCalledTimes(2);
    stopRunEventJournalBuffer();
    expect(nativeUnlisten).toHaveBeenCalledTimes(1);
  });

  it("allows native stream initialization to retry after a rejected startup", async () => {
    window.__TAURI_INTERNALS__ = {} as Window["__TAURI_INTERNALS__"];
    const onRunEvent = vi.spyOn(desktop, "onRunEvent")
      .mockRejectedValueOnce(new Error("Native event host not initialized"))
      .mockResolvedValueOnce(vi.fn());
    await expect(startRunEventJournalBuffer()).rejects.toThrow("Native event host not initialized");
    await expect(startRunEventJournalBuffer()).resolves.toBeUndefined();
    expect(onRunEvent).toHaveBeenCalledTimes(2);
  });
});
