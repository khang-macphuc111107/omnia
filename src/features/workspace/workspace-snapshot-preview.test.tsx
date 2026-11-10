import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useWorkspaceStore } from "./store";
import { WorkspaceSnapshotPreview } from "./workspace-snapshot-preview";

const initialState = useWorkspaceStore.getState();

describe("Workspace snapshot preview", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("keeps advanced metadata controls collapsed until requested", () => {
    render(<WorkspaceSnapshotPreview />);

    const customize = screen.getByRole("button", { name: "Customize snapshot" });
    expect(customize).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("checkbox", { name: "Redacted diagnostics" })).not.toBeInTheDocument();

    fireEvent.click(customize);
    expect(screen.getByRole("button", { name: "Hide options" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("checkbox", { name: "Redacted diagnostics" })).not.toBeChecked();
  });

  it("keeps selected snapshot metadata renderer-local and reversible", () => {
    render(<WorkspaceSnapshotPreview />);

    expect(
      screen.getByRole("heading", { name: /Compose a snapshot before native storage exists/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/does not read files, freeze a run, persist a restore point/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Customize snapshot" }));
    const diagnostics = screen.getByRole("checkbox", { name: "Redacted diagnostics" });
    expect(diagnostics).not.toBeChecked();
    fireEvent.click(diagnostics);
    expect(diagnostics).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent(/Redacted diagnostics included/i);

    fireEvent.click(screen.getByRole("button", { name: "Undo workspace snapshot preview change" }));
    expect(diagnostics).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Redo workspace snapshot preview change" }));
    expect(diagnostics).toBeChecked();
  });

  it("creates an inspectable JSON or Markdown manifest without claiming a native snapshot", () => {
    render(<WorkspaceSnapshotPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Workspace snapshot scope" }), {
      target: { value: "workspace" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(/Entire workspace selected/i);

    fireEvent.click(screen.getByRole("button", { name: "Generate preview" }));
    const preview = screen.getByRole("region", { name: "Workspace snapshot manifest preview" });
    expect(within(preview).getByRole("code")).toHaveTextContent(
      /omnia\.workspace-snapshot-preview\.v1/i,
    );
    expect(within(preview).getByText(/not a native snapshot, backup, restore point/i)).toBeInTheDocument();

    fireEvent.change(within(preview).getByRole("combobox", { name: "Workspace snapshot export format" }), {
      target: { value: "markdown" },
    });
    expect(within(preview).getByRole("code")).toHaveTextContent(/# Omnia workspace snapshot preview/i);
    expect(within(preview).getByRole("code")).toHaveTextContent(/Entire workspace/i);
  });

  it("resets the draft to the safe active-project metadata defaults", () => {
    render(<WorkspaceSnapshotPreview />);

    fireEvent.change(screen.getByRole("textbox", { name: "Workspace snapshot label" }), {
      target: { value: "Research handoff" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Workspace snapshot scope" }), {
      target: { value: "active-chat" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Customize snapshot" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Attachment metadata" }));

    fireEvent.click(screen.getByRole("button", { name: "Reset workspace snapshot preview" }));
    expect(screen.getByRole("textbox", { name: "Workspace snapshot label" })).toHaveValue(
      "Omnia workspace preview",
    );
    expect(screen.getByRole("combobox", { name: "Workspace snapshot scope" })).toHaveValue(
      "active-project",
    );
    expect(screen.getByRole("checkbox", { name: "Attachment metadata" })).toBeChecked();
  });
});
