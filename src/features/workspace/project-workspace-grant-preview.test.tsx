import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectWorkspaceGrantPreview } from "./project-workspace-grant-preview";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("Project workspace grant preview", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("adds, edits, revokes, and restores grants without mutating the project store", () => {
    const project = useWorkspaceStore.getState().projects[0]!;
    const originalFolders = project.folders.map((folder) => ({ ...folder }));
    render(<ProjectWorkspaceGrantPreview project={project} />);

    expect(screen.getByText(/No durable write/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add grant in preview" }));
    const editor = screen.getByRole("form");
    fireEvent.change(within(editor).getByLabelText("Display name"), { target: { value: "Docs preview" } });
    fireEvent.change(within(editor).getByLabelText("Workspace path"), { target: { value: "C:\\Workspace\\Docs" } });
    fireEvent.change(within(editor).getByLabelText("Access scope"), { target: { value: "metadata" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Apply preview" }));

    expect(screen.getByText("Docs preview")).toBeInTheDocument();
    expect(screen.getByText("Metadata only")).toBeInTheDocument();
    expect(useWorkspaceStore.getState().projects[0]?.folders).toEqual(originalFolders);

    fireEvent.click(screen.getByRole("button", { name: "Preview access map" }));
    const exportPreview = screen.getByRole("region", { name: "Workspace grant export preview" });
    expect(within(exportPreview).getByRole("code")).toHaveTextContent(/omnia\.workspace-grants\.preview\.v1/i);
    fireEvent.change(within(exportPreview).getByRole("combobox", { name: "Workspace grant export format" }), { target: { value: "markdown" } });
    expect(within(exportPreview).getByRole("code")).toHaveTextContent(/workspace grants preview/i);

    fireEvent.click(screen.getByRole("button", { name: "Edit Docs preview grant preview" }));
    const editEditor = screen.getByRole("form");
    fireEvent.change(within(editEditor).getByLabelText("Access scope"), { target: { value: "selected-files" } });
    fireEvent.click(within(editEditor).getByRole("button", { name: "Apply preview" }));
    expect(screen.getByText("Selected files")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Revoke Docs preview grant preview" }));
    expect(screen.queryByText("Docs preview")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo workspace grant preview change" }));
    expect(screen.getByText("Docs preview")).toBeInTheDocument();
  });

  it("resets access preview to the selected project's folders", () => {
    const project = useWorkspaceStore.getState().projects[0]!;
    render(<ProjectWorkspaceGrantPreview project={project} />);

    fireEvent.click(screen.getByRole("button", { name: "Add grant in preview" }));
    const editor = screen.getByRole("form");
    fireEvent.change(within(editor).getByLabelText("Display name"), { target: { value: "Temporary" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Apply preview" }));
    expect(screen.getByText("Temporary")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset workspace grant preview" }));
    expect(screen.queryByText("Temporary")).not.toBeInTheDocument();
    expect(screen.getByText(project.folders[0]!.displayName)).toBeInTheDocument();
    expect(screen.getByText(/Workspace-grant preview reset/i)).toBeInTheDocument();
  });
});
