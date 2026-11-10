import { afterEach, describe, expect, it, vi } from "vitest";

import { desktop, type RunTelemetrySnapshot } from "@/lib/desktop";

import { refreshRunTelemetryIntoStore } from "./run-journal-sync";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();
const runId = "run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function snapshot(): RunTelemetrySnapshot {
  return {
    schemaVersion: 1,
    runId,
    attempts: [],
    readAtMs: 1_786_800_000_000,
  };
}

describe("native telemetry sync", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    vi.restoreAllMocks();
  });

  it("upserts an exact native snapshot without blending it into journal state", async () => {
    vi.spyOn(desktop, "readRunTelemetry").mockResolvedValue(snapshot());

    await expect(refreshRunTelemetryIntoStore(runId)).resolves.toEqual(snapshot());

    expect(desktop.readRunTelemetry).toHaveBeenCalledWith({ runId });
    expect(useWorkspaceStore.getState().runTelemetryByRunId).toEqual({ [runId]: snapshot() });
    expect(useWorkspaceStore.getState().runTimelineEvents).toEqual(initialState.runTimelineEvents);
  });

  it("does not replace missing native telemetry with zero-valued fixture data", async () => {
    vi.spyOn(desktop, "readRunTelemetry").mockRejectedValue(new Error("telemetry unavailable"));

    await expect(refreshRunTelemetryIntoStore(runId)).resolves.toBeNull();

    expect(useWorkspaceStore.getState().runTelemetryByRunId).toEqual({});
  });
});

