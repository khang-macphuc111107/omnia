import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandPaletteHost } from "./command-palette-host";
import { GlobalDialogsHost } from "./global-dialogs-host";
import { closeWorkspaceOverlay, openWorkspaceOverlay } from "./overlay-store";
import { useWorkspaceStore } from "./store";

describe("lazy overlay hosts", () => {
  beforeEach(() => {
    useWorkspaceStore.getState().setCommandPaletteOpen(false);
    closeWorkspaceOverlay();
  });

  afterEach(() => {
    cleanup();
    useWorkspaceStore.getState().setCommandPaletteOpen(false);
    closeWorkspaceOverlay();
  });

  it("loads the command palette into exactly one modal scrim", async () => {
    render(<CommandPaletteHost />);

    // `lazy()` schedules a second dynamic import from inside the first
    // module-loader promise.  Waiting for Vitest's import queue *inside* async
    // `act` keeps the lazy resolution update in React's test transaction and
    // prevents this contract from depending on worker scheduling when the
    // suite runs in parallel with other large lazy modules.
    await act(async () => {
      useWorkspaceStore.getState().setCommandPaletteOpen(true);
      await vi.dynamicImportSettled();
    });

    expect(
      await screen.findByRole("dialog", { name: "Omnia search and command palette" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll(".modal-scrim")).toHaveLength(1));
    expect(document.querySelectorAll(".command-scrim")).toHaveLength(1);
  });

  it("loads a global dialog into exactly one modal scrim", async () => {
    render(<GlobalDialogsHost />);

    await act(async () => {
      openWorkspaceOverlay({ kind: "create-project" });
      await vi.dynamicImportSettled();
    });

    expect(await screen.findByRole("dialog", { name: "Create a project" })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll(".modal-scrim")).toHaveLength(1));
  });
});
