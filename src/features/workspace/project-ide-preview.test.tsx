import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useWorkspaceStore } from "./store";
import { ProjectIdePreview } from "./project-ide-preview";

describe("Project IDE preview", () => {
  it("shows a coder-friendly file tree, editor, diff, and outline without native claims", () => {
    const project = useWorkspaceStore.getState().projects[0]!;
    render(<ProjectIdePreview project={project} />);

    expect(screen.getByRole("heading", { name: "Project IDE surface" })).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: "Preview files" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /main\.ts/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/no workspace file was read/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("title", "Open terminal and compiler rehearsal");

    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    expect(screen.getByRole("region", { name: "Preview diff" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    expect(screen.getByText("greet(name: string)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Problems" }));
    expect(screen.getByRole("heading", { name: "Problems" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Preview diagnostics" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.getByRole("heading", { name: "Terminal & compiler preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run command preview" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    expect(screen.getByRole("heading", { name: "Git & CI/CD workbench" })).toBeInTheDocument();
    expect(screen.getByText(/no repository was read/i)).toBeInTheDocument();
  });

  it("keeps edits, undo, reset, and run actions renderer-local", () => {
    const project = useWorkspaceStore.getState().projects[0]!;
    render(<ProjectIdePreview project={project} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit preview" }));
    const editor = screen.getByRole("textbox", { name: /Edit src\/main\.ts/i });
    fireEvent.change(editor, { target: { value: "export const changed = true;" } });
    expect(screen.getByRole("status")).toHaveTextContent(/unsaved renderer-local edit/i);

    fireEvent.click(screen.getByRole("button", { name: "Reset current IDE preview file" }));
    expect(screen.getByRole("status")).toHaveTextContent(/reset in preview/i);
    fireEvent.click(screen.getByRole("button", { name: "Run preview" }));
    expect(screen.getByRole("status")).toHaveTextContent(/no process was started/i);

    const actions = screen.getByRole("toolbar", { name: "Project IDE preview actions" });
    expect(within(actions).getByRole("button", { name: "Undo IDE preview edit" })).not.toBeDisabled();
    expect(screen.getByText(/does not read or write folders/i)).toBeInTheDocument();
  });

  it("supports keyboard navigation through the synthetic file tree", () => {
    const project = useWorkspaceStore.getState().projects[0]!;
    render(<ProjectIdePreview project={project} />);

    const fileTree = screen.getByRole("listbox", { name: "Preview files" });
    expect(fileTree).toHaveAttribute("aria-activedescendant", "project-ide-file-main");
    expect(fileTree).toHaveAttribute("aria-describedby", "project-ide-file-tree-help");

    fireEvent.keyDown(fileTree, { key: "End" });
    expect(screen.getByRole("option", { name: "package.json" })).toHaveAttribute("aria-selected", "true");
    expect(fileTree).toHaveAttribute("aria-activedescendant", "project-ide-file-package");

    fireEvent.keyDown(fileTree, { key: "Home" });
    expect(screen.getByRole("option", { name: "README.md" })).toHaveAttribute("aria-selected", "true");
    expect(fileTree).toHaveAttribute("aria-activedescendant", "project-ide-file-readme");
    expect(fileTree).toHaveAttribute("aria-keyshortcuts", "ArrowDown ArrowUp Home End");
  });

  it("supports renderer-local editor preferences and quick-open shortcuts", () => {
    const project = useWorkspaceStore.getState().projects[0]!;
    render(<ProjectIdePreview project={project} />);

    const search = screen.getByRole("textbox", { name: "Search preview files" });
    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    expect(search).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Open editor preview settings" }));
    const settings = screen.getByRole("dialog", { name: "Editor preview settings" });
    expect(settings).toHaveAttribute("aria-describedby", "project-ide-editor-settings-help");
    expect(within(settings).getByRole("checkbox", { name: "Show line numbers" })).toBeChecked();
    fireEvent.click(within(settings).getByRole("checkbox", { name: "Word wrap" }));
    fireEvent.click(within(settings).getByRole("checkbox", { name: "Show whitespace" }));

    const code = screen.getByLabelText("Preview code for src/main.ts");
    expect(code).toHaveClass("project-ide-preview__code--wrap");
    expect(code).toHaveClass("project-ide-preview__code--whitespace");

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(screen.getByRole("status")).toHaveTextContent(/save rehearsal acknowledged/i);
    fireEvent.click(within(settings).getByRole("button", { name: "Reset" }));
    expect(code).not.toHaveClass("project-ide-preview__code--wrap");
  });

  it("connects the open-file tab to its panel and moves focus into settings", () => {
    const project = useWorkspaceStore.getState().projects[0]!;
    render(<ProjectIdePreview project={project} />);

    const tab = screen.getByRole("tab", { name: /main\.ts/i });
    const panel = screen.getByRole("tabpanel");
    expect(tab).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("aria-labelledby", tab.id);

    fireEvent.click(screen.getByRole("button", { name: "Open editor preview settings" }));
    const settings = screen.getByRole("dialog", { name: "Editor preview settings" });
    expect(within(settings).getByRole("checkbox", { name: "Show line numbers" })).toHaveFocus();
  });

  it("dismisses editor settings without leaving a stale overlay over another IDE surface", () => {
    const project = useWorkspaceStore.getState().projects[0]!;
    render(<ProjectIdePreview project={project} />);

    const trigger = screen.getByRole("button", { name: "Open editor preview settings" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Editor preview settings" })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Editor preview settings" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Editor preview settings" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Editor preview settings" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    expect(screen.queryByRole("dialog", { name: "Editor preview settings" })).not.toBeInTheDocument();
  });
});
