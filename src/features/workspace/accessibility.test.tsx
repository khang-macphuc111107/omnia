import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CommandPalette } from "./command-palette";
import { ProjectDialog } from "./dialogs";
import { ContextInspectorPanel } from "./inspector";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("workspace accessibility contracts", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("connects the command input to its listbox and active option", () => {
    useWorkspaceStore.setState({
      commandPaletteOpen: true,
      conversations: [],
      projects: [],
    });

    render(<CommandPalette />);

    const input = screen.getByRole("combobox", {
      name: "Filter commands, chats, projects, memory, skills, library, providers, and models",
    });
    const listbox = screen.getByRole("listbox", { name: "Search results" });

    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-activedescendant", "command-result-new-chat");
  });

  it("gives a dialog a unique accessible title and description and moves focus inside", async () => {
    render(<ProjectDialog onClose={() => undefined} />);

    const dialog = screen.getByRole("dialog", { name: "Create a project" });
    const description = screen.getByText(/A (?:browser-preview|local) container for conversations/);

    expect(dialog).toHaveAttribute("aria-describedby", description.id);
    expect(await screen.findByRole("textbox", { name: "Project name" })).toHaveFocus();
  });

  it("implements a roving keyboard tablist for the inspector", () => {
    useWorkspaceStore.setState({ inspectorOpen: true, inspectorTab: "context" });

    render(<ContextInspectorPanel />);

    const inspectorTabs = screen.getByRole("tablist", { name: "Inspector view" });
    const contextTab = within(inspectorTabs).getByRole("tab", { name: "Context" });
    const runTab = within(inspectorTabs).getByRole("tab", { name: "Run" });
    expect(contextTab).toHaveAttribute("tabindex", "0");
    expect(runTab).toHaveAttribute("tabindex", "-1");

    contextTab.focus();
    fireEvent.keyDown(contextTab, { key: "ArrowRight" });

    expect(runTab).toHaveFocus();
    expect(runTab).toHaveAttribute("aria-selected", "true");
    const inspector = screen.getByRole("complementary", { name: "Context and run inspector" });
    expect(within(inspector).getByRole("tabpanel", { name: "Run" })).toHaveAttribute("aria-labelledby", runTab.id);
  });

  it("gives advanced range controls stable accessible names and value references", () => {
    useWorkspaceStore.setState({ inspectorOpen: true, inspectorTab: "parameters" });

    render(<ContextInspectorPanel />);

    const temperature = screen.getByRole("slider", { name: "Temperature" });
    const topP = screen.getByRole("slider", { name: "Top P" });

    expect(temperature).toHaveAttribute("aria-describedby", "temperature-value");
    expect(topP).toHaveAttribute("aria-describedby", "top-p-value");
  });
});
