import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceStore } from "../store";
import ProjectsScreen from "./projects-screen";

vi.mock("../overlay-store", () => ({
  openWorkspaceOverlay: vi.fn(),
}));

vi.mock("../project-overview", () => ({
  ProjectOverview: () => <div data-testid="project-overview-stub" />,
}));

vi.mock("../project-control-deck", () => ({
  ProjectControlDeck: () => <div data-testid="project-control-deck-stub" />,
}));

const initialWorkspaceState = useWorkspaceStore.getState();

afterEach(() => {
  useWorkspaceStore.setState(initialWorkspaceState, true);
});

function renderProjects() {
  return render(<ProjectsScreen />);
}

describe("ProjectsScreen interactions", () => {
  it("opens a card menu, supports roving keyboard focus, and restores the trigger on Escape", async () => {
    renderProjects();

    const trigger = screen.getByRole("button", { name: "Open project library actions for Omnia Desktop" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const menu = await screen.findByRole("menu", { name: "Project library actions for Omnia Desktop" });
    const menuItems = within(menu).getAllByRole("menuitem").filter((item) => !item.hasAttribute("disabled"));
    expect(menuItems[0]).toHaveFocus();

    fireEvent.keyDown(menuItems[0]!, { key: "ArrowDown" });
    expect(menuItems[1]).toHaveFocus();
    fireEvent.keyDown(menuItems[1]!, { key: "End" });
    expect(menuItems.at(-1)).toHaveFocus();

    fireEvent.keyDown(menuItems.at(-1)!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Project library actions for Omnia Desktop" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps only one project action menu open and dismisses it outside the menu", async () => {
    renderProjects();

    const omniaTrigger = screen.getByRole("button", { name: "Open project library actions for Omnia Desktop" });
    const researchTrigger = screen.getByRole("button", { name: "Open project library actions for Research notebook" });
    fireEvent.click(omniaTrigger);
    expect(screen.getByRole("menu", { name: "Project library actions for Omnia Desktop" })).toBeInTheDocument();

    fireEvent.click(researchTrigger);
    expect(screen.queryByRole("menu", { name: "Project library actions for Omnia Desktop" })).not.toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "Project library actions for Research notebook" })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Project library actions for Research notebook" })).not.toBeInTheDocument());
    expect(researchTrigger).toHaveAttribute("aria-expanded", "false");
  });

  it("does not confuse the selected-card and detail action menus", async () => {
    renderProjects();

    const cardTrigger = screen.getByRole("button", { name: "Open project library actions for Omnia Desktop" });
    const detailTrigger = screen.getByRole("button", { name: "Open preview actions for Omnia Desktop" });
    fireEvent.click(cardTrigger);
    expect(screen.getByRole("menu", { name: "Project library actions for Omnia Desktop" })).toBeInTheDocument();

    fireEvent.click(detailTrigger);
    expect(screen.queryByRole("menu", { name: "Project library actions for Omnia Desktop" })).not.toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "Project actions for Omnia Desktop" })).toBeInTheDocument();
    expect(detailTrigger).toHaveAttribute("aria-expanded", "true");
  });

  it("dismisses the workspace-folder menu with Escape and returns focus to its trigger", async () => {
    renderProjects();

    const folderTrigger = screen.getByRole("button", { name: "Open workspace-grant preview actions for Omnia" });
    fireEvent.click(folderTrigger);
    const menu = await screen.findByRole("menu", { name: "Workspace-grant preview actions for Omnia" });
    expect(within(menu).getByRole("menuitem", { name: "Open Access preview" })).toHaveFocus();

    fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "Open Access preview" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Workspace-grant preview actions for Omnia" })).not.toBeInTheDocument());
    expect(folderTrigger).toHaveFocus();
  });

  it("does not apply a rename draft to a different project after selection changes", async () => {
    renderProjects();

    const omniaTrigger = screen.getByRole("button", { name: "Open project library actions for Omnia Desktop" });
    fireEvent.click(omniaTrigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename in preview" }));

    const renameInput = screen.getByRole("textbox", { name: "Rename project in preview" });
    fireEvent.change(renameInput, { target: { value: "Renamed Omnia" } });
    expect(renameInput).toHaveValue("Renamed Omnia");

    fireEvent.click(screen.getByRole("button", { name: "Select Research notebook" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Rename project in preview" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Research notebook" })).toBeInTheDocument();
    expect(screen.queryByText("Renamed Omnia")).not.toBeInTheDocument();
  });
});
