import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WorkbenchDeck } from "./workbench-deck";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("advanced workbench deck preview", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("keeps the active tab linked to the visible panel while switching workbenches", () => {
    render(<WorkbenchDeck />);

    const routeTab = screen.getByRole("tab", { name: "Route" });
    expect(routeTab).toHaveAttribute("aria-selected", "true");
    expect(routeTab).toHaveAttribute("aria-controls", "workbench-panel-route");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "workbench-panel-route");
    expect(screen.getByRole("heading", { name: "Routing Workbench" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Branches" }));

    const branchesTab = screen.getByRole("tab", { name: "Branches" });
    expect(branchesTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Route" })).toHaveAttribute("aria-selected", "false");
    const branchesPanel = document.getElementById("workbench-panel-branches");
    expect(branchesPanel).toBeInTheDocument();
    expect(branchesPanel).toHaveAttribute("role", "tabpanel");
    expect(within(branchesPanel!).getByText(/visible branches?/i)).toBeInTheDocument();
    const openBranchButton = within(branchesPanel!).getByRole("button", { name: /create branch/i });
    expect(openBranchButton).toBeEnabled();
    fireEvent.click(openBranchButton);
    expect(screen.getByRole("button", { name: "Create branch" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    expect(screen.getByText(/branch creation is planned/i)).toBeInTheDocument();
    expect(within(branchesPanel!).getByText(/native bridge/i)).toBeInTheDocument();
  });

  it("supports roving keyboard navigation across workbench tabs", () => {
    render(<WorkbenchDeck />);

    const routeTab = screen.getByRole("tab", { name: "Route" });
    routeTab.focus();
    fireEvent.keyDown(routeTab, { key: "ArrowRight" });

    const branchesTab = screen.getByRole("tab", { name: "Branches" });
    expect(branchesTab).toHaveFocus();
    expect(branchesTab).toHaveAttribute("aria-selected", "true");
    expect(routeTab).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(branchesTab, { key: "End" });
    const capabilitiesTab = screen.getByRole("tab", { name: "Capabilities" });
    expect(capabilitiesTab).toHaveFocus();
    expect(capabilitiesTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "workbench-tab-capabilities");
  });

  it("exposes a fail-closed state-base and cursor preview", () => {
    render(<WorkbenchDeck />);

    fireEvent.click(screen.getByRole("tab", { name: "State base" }));

    const panel = document.getElementById("workbench-panel-state-base");
    expect(panel).toBeInTheDocument();
    expect(within(panel!).getByRole("heading", { name: "State base & cursor workbench" })).toBeInTheDocument();
    expect(within(panel!).getByText(/No canonical state base is hydrated/i)).toBeInTheDocument();
    fireEvent.click(within(panel!).getByRole("tab", { name: "Cursors" }));
    expect(within(panel!).getByText(/No cursor provenance is hydrated/i)).toBeInTheDocument();
  });

  it("exposes context and preset controls as honest renderer previews", () => {
    render(<WorkbenchDeck />);

    fireEvent.click(screen.getByRole("tab", { name: "Context" }));

    const contextPanel = document.getElementById("workbench-panel-context");
    expect(contextPanel).toBeInTheDocument();
    expect(contextPanel).toHaveTextContent("Project Context");
    expect(contextPanel).toHaveTextContent(/1 folder/);
    expect(contextPanel).toHaveTextContent("Not compiled");
    expect(contextPanel!.querySelector(".project-context-workbench__status")).toHaveTextContent("Preview only");

    fireEvent.click(screen.getByRole("tab", { name: "Presets" }));

    const presetsPanel = document.getElementById("workbench-panel-presets");
    expect(presetsPanel).toBeInTheDocument();
    expect(within(presetsPanel!).getByRole("heading", { name: "Profiles & presets" })).toBeInTheDocument();
    fireEvent.click(within(presetsPanel!).getByText("Creative").closest("button")!);
    expect(useWorkspaceStore.getState().parameters.temperature).toBe(1.1);
    expect(within(presetsPanel!).getByText(/Temperature 1\.1/)).toBeInTheDocument();
    expect(within(presetsPanel!).getByText(/renderer-local/i)).toBeInTheDocument();
  });
});
