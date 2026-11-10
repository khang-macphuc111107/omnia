import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import * as desktopModule from "@/lib/desktop";
import { NativeProjectGoals } from "./native-project-goals";

const { desktop } = desktopModule;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const projectId = "project-native-goals-test";

function goalSummary(overrides: Partial<Awaited<ReturnType<typeof desktop.listGoals>>[number]> = {}) {
  return {
    id: "goal-1",
    profileId: "profile-1",
    projectId,
    conversationId: null,
    branchId: null,
    currentRevisionId: "rev-1",
    stateRevisionId: null,
    status: "draft" as const,
    title: "Ship a stable release",
    canonicalPayloadSha256: "hash",
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function goalSnapshot(title = "Ship a stable release") {
  const goal = {
    id: "goal-1",
    profileId: "profile-1",
    projectId,
    conversationId: null,
    branchId: null,
    currentRevisionId: "rev-1",
    stateRevisionId: null,
    status: "draft" as const,
    title,
    description: null,
    acceptanceCriteriaJson: "[]",
    roadmapJson: "{}",
    metadataJson: "{}",
    canonicalPayloadSha256: "hash",
    createdAtMs: 1,
    updatedAtMs: 1,
    deletedAtMs: null,
  };
  return {
    goal,
    currentRevision: {
      revisionId: "rev-1",
      goalId: "goal-1",
      revisionNo: 1,
      payloadJson: "{}",
      contentSha256: "hash",
      stateRevisionId: null,
      createdAtMs: 1,
    },
    executionDisposition: "preview-only" as const,
    integrity: "valid" as const,
    replayed: false,
  };
}

describe("NativeProjectGoals", () => {
  it("labels browser preview unavailable without calling native storage", () => {
    vi.spyOn(desktopModule, "isDesktopRuntime").mockReturnValue(false);
    const listSpy = vi.spyOn(desktop, "listGoals");

    render(<NativeProjectGoals projectId={projectId} projectName="Omnia" />);

    expect(screen.getByRole("status")).toHaveTextContent(/unavailable in this browser preview/i);
    expect(screen.queryByRole("button", { name: "Refresh saved project goals" })).not.toBeInTheDocument();
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("creates a native draft for the exact Project and refreshes its authoritative list", async () => {
    vi.spyOn(desktopModule, "isDesktopRuntime").mockReturnValue(true);
    vi.spyOn(desktop, "listGoals").mockResolvedValueOnce([]).mockResolvedValueOnce([goalSummary()]);
    const createSpy = vi.spyOn(desktop, "createGoal").mockResolvedValue(goalSnapshot());

    render(<NativeProjectGoals projectId={projectId} projectName="Omnia" />);
    await waitFor(() => expect(desktop.listGoals).toHaveBeenCalledWith({ projectId, includeArchived: false, limit: 50 }));
    fireEvent.change(screen.getByRole("textbox", { name: "New project goal title" }), { target: { value: "Ship a stable release" } });
    fireEvent.change(screen.getByRole("textbox", { name: "New project goal outcome" }), { target: { value: "No release-blocking bugs" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    const request = createSpy.mock.calls[0]?.[0];
    expect(request).toMatchObject({ projectId, title: "Ship a stable release", description: "No release-blocking bugs", status: "draft" });
    expect(request?.idempotencyKey).toMatch(/^project-goal:/);
    await waitFor(() => expect(screen.getByText("Ship a stable release")).toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent(/native draft.*preview-only/i);
    expect(desktop.listGoals).toHaveBeenCalledTimes(2);
  });

  it("locks and retries a failed creation with the same exact request key", async () => {
    vi.spyOn(desktopModule, "isDesktopRuntime").mockReturnValue(true);
    vi.spyOn(desktop, "listGoals").mockResolvedValue([]);
    const createSpy = vi.spyOn(desktop, "createGoal")
      .mockRejectedValueOnce(new Error("Native command outcome was not confirmed"))
      .mockResolvedValueOnce(goalSnapshot("Keep the same request"));

    render(<NativeProjectGoals projectId={projectId} projectName="Omnia" />);
    await waitFor(() => expect(desktop.listGoals).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("textbox", { name: "New project goal title" }), { target: { value: "Keep the same request" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("textbox", { name: "New project goal title" })).toBeDisabled();
    const failedKey = createSpy.mock.calls[0]?.[0].idempotencyKey;
    fireEvent.click(screen.getByRole("button", { name: "Retry same draft" }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(2));
    expect(createSpy.mock.calls[1]?.[0]).toMatchObject({ title: "Keep the same request", idempotencyKey: failedKey });
  });
});
