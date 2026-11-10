import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import WorkspaceFileRootsPreview from "./workspace-file-roots-preview";

describe("WorkspaceFileRootsPreview", () => {
  it("renders the session-only root catalog and filters it", () => {
    render(<WorkspaceFileRootsPreview />);

    expect(screen.getByRole("heading", { name: "Workspace file roots" })).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "Workspace file roots preview boundary" })).toHaveTextContent(
      /no filesystem read/i,
    );
    expect(screen.getByRole("list", { name: "Workspace file roots" })).toHaveTextContent(/Omnia source/);

    fireEvent.change(screen.getByPlaceholderText(/Search labels/i), { target: { value: "Research" } });
    expect(screen.getByRole("list", { name: "Workspace file roots" })).toHaveTextContent(/Research vault/);
    expect(screen.getByRole("list", { name: "Workspace file roots" })).not.toHaveTextContent(/Omnia source/);

    fireEvent.change(screen.getByRole("combobox", { name: "Workspace file roots status filter" }), {
      target: { value: "offline" },
    });
    expect(screen.getByRole("list", { name: "Workspace file roots" })).toHaveTextContent(/No roots match/);
  });

  it("adds a root and supports undo and redo in the renderer session", () => {
    render(<WorkspaceFileRootsPreview />);

    fireEvent.click(screen.getByRole("button", { name: "Add root" }));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Scratch lab" } });
    fireEvent.change(screen.getByLabelText("Root path"), { target: { value: "D:\\Scratch" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply preview" }));

    const list = screen.getByRole("list", { name: "Workspace file roots" });
    expect(list).toHaveTextContent(/Scratch lab/);
    fireEvent.click(screen.getByRole("button", { name: "Undo workspace file root preview change" }));
    expect(list).not.toHaveTextContent(/Scratch lab/);
    fireEvent.click(screen.getByRole("button", { name: "Redo workspace file root preview change" }));
    expect(list).toHaveTextContent(/Scratch lab/);
  });

  it("offers an inspectable export with explicit preview boundaries", () => {
    render(<WorkspaceFileRootsPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Export / import" }));

    const exportRegion = screen.getByRole("region", { name: "Workspace file roots export and import preview" });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/omnia\.workspace-file-roots\.preview\.v1/);
    expect(exportRegion).toHaveTextContent(/no filesystem was inspected/i);

    fireEvent.change(within(exportRegion).getByRole("combobox", { name: "Workspace file roots export format" }), {
      target: { value: "markdown" },
    });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/# Omnia workspace file roots preview/);
  });

  it("rehearses a bounded indexing plan with undo and export metadata", () => {
    render(<WorkspaceFileRootsPreview />);

    fireEvent.click(screen.getByRole("button", { name: "Index plan" }));
    const plan = screen.getByRole("region", { name: "Workspace indexing plan preview" });
    expect(plan).toHaveTextContent(/does not enumerate files.*start a watcher/i);

    fireEvent.change(within(plan).getByRole("combobox", { name: "Parser strategy" }), {
      target: { value: "source" },
    });
    fireEvent.change(within(plan).getByRole("spinbutton", { name: "Max file size (MB)" }), {
      target: { value: "16" },
    });
    expect(within(plan).getByRole("combobox", { name: "Parser strategy" })).toHaveValue("source");
    expect(within(plan).getByRole("spinbutton", { name: "Max file size (MB)" })).toHaveValue(16);

    fireEvent.click(within(plan).getByRole("button", { name: "Undo" }));
    expect(within(plan).getByRole("spinbutton", { name: "Max file size (MB)" })).toHaveValue(8);

    fireEvent.click(screen.getByRole("button", { name: "Export / import" }));
    expect(screen.getByRole("code")).toHaveTextContent(/"indexPlan"/);
  });
});
