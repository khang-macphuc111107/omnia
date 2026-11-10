import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GlobalDialogs } from "./dialogs";
import {
  closeWorkspaceOverlay,
  openWorkspaceOverlay,
  useWorkspaceOverlayStore,
} from "./overlay-store";
import { useWorkspaceStore } from "./store";

describe("workspace overlay controller", () => {
  beforeEach(() => {
    closeWorkspaceOverlay();
  });

  afterEach(() => {
    closeWorkspaceOverlay();
    document.body.innerHTML = "";
  });

  it("opens and closes a typed project overlay without a global window event", () => {
    render(<GlobalDialogs />);

    act(() => openWorkspaceOverlay({ kind: "create-project" }));
    expect(screen.getByRole("dialog", { name: "Create a project" })).toBeInTheDocument();
    expect(useWorkspaceOverlayStore.getState().activeOverlay).toEqual({ kind: "create-project" });

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useWorkspaceOverlayStore.getState().activeOverlay).toBeNull();
  });

  it("pins a folder grant to the project carried by the overlay payload", () => {
    const [first, second] = useWorkspaceStore.getState().projects;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    useWorkspaceStore.setState({ activeProjectId: first!.id });
    render(<GlobalDialogs />);

    act(() => openWorkspaceOverlay({ kind: "grant-folder", projectId: second!.id }));

    expect(screen.getByRole("dialog", { name: "Add workspace folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Choose a folder/i })).toBeEnabled();
    expect(useWorkspaceOverlayStore.getState().activeOverlay).toEqual({
      kind: "grant-folder",
      projectId: second!.id,
    });
  });
});
