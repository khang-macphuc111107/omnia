import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import WorkspaceFileBrowserPreview from "./workspace-file-browser-preview";

describe("WorkspaceFileBrowserPreview", () => {
  it("renders the preview-only browser with a tree and selected file", () => {
    render(<WorkspaceFileBrowserPreview />);

    expect(screen.getByRole("heading", { name: "Workspace File Browser" })).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "Workspace file browser boundary" })).toHaveTextContent(/does not read your drives/i);
    expect(screen.getByRole("tree", { name: "Sample file tree" })).toHaveTextContent("App.tsx");
    expect(screen.getByRole("region", { name: "Preview of README.md" })).toHaveTextContent(/Project overview/i);
  });

  it("filters files, switches list view, and selects a different preview", () => {
    render(<WorkspaceFileBrowserPreview />);

    fireEvent.change(screen.getByPlaceholderText(/Search files/i), { target: { value: "package" } });
    fireEvent.click(screen.getByRole("button", { name: "List" }));

    const list = screen.getByRole("list", { name: "Sample files" });
    expect(list).toHaveTextContent("package.json");
    expect(list).not.toHaveTextContent("App.tsx");

    fireEvent.click(within(list).getByRole("button", { name: "Open package.json" }));
    expect(screen.getByRole("region", { name: "Preview of package.json" })).toHaveTextContent(/dependency metadata/i);
  });

  it("supports starred filtering and preserves an explicit no-disk boundary", () => {
    render(<WorkspaceFileBrowserPreview />);

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("button", { name: "Starred" }));
    expect(screen.getByRole("list", { name: "Sample files" })).toHaveTextContent("App.tsx");
    expect(screen.getByRole("list", { name: "Sample files" })).not.toHaveTextContent("README.md");

    fireEvent.click(screen.getByRole("button", { name: "Unstar App.tsx" }));
    expect(screen.getByRole("list", { name: "Sample files" })).toHaveTextContent(/No sample files match/i);
    expect(screen.getByText(/not read from disk/i)).toBeInTheDocument();
  });

  it("keeps tree results aligned with list filters and makes a hidden selection explicit", () => {
    render(<WorkspaceFileBrowserPreview />);

    fireEvent.change(screen.getByPlaceholderText(/Search files/i), { target: { value: ".css" } });

    expect(screen.getByRole("tree", { name: "Sample file tree" })).toHaveTextContent("tokens.css");
    expect(screen.getByRole("tree", { name: "Sample file tree" })).not.toHaveTextContent("App.tsx");
    expect(screen.getByRole("region", { name: "File preview hidden" })).toHaveTextContent(/outside the visible file set/i);

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("region", { name: "Preview of README.md" })).toBeInTheDocument();
  });

  it("labels tree chevrons with the folder action they perform", () => {
    render(<WorkspaceFileBrowserPreview />);

    const srcFolder = screen.getByRole("button", { name: "Collapse folder src" });
    expect(srcFolder).toHaveAttribute("title", "Collapse folder src");
    expect(srcFolder).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(srcFolder);
    expect(screen.getByRole("button", { name: "Expand folder src" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Open App.tsx" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand folder src" }));
    expect(screen.getByRole("button", { name: "Open App.tsx" })).toBeInTheDocument();
  });

  it("supports visible multi-selection and batch starring", () => {
    render(<WorkspaceFileBrowserPreview />);

    fireEvent.click(screen.getByRole("button", { name: "Select visible" }));
    expect(screen.getByText("7 selected · 7 visible")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Unstar selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Star selected" }));
    expect(screen.getByRole("button", { name: "Starred" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByText("0 selected · 7 visible")).toBeInTheDocument();
  });

  it("exports selected file metadata without including sample contents", () => {
    render(<WorkspaceFileBrowserPreview />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select README.md" }));
    fireEvent.click(screen.getByRole("button", { name: "Export selection" }));

    expect(screen.getByRole("region", { name: "Selected file export preview" })).toHaveTextContent(/omnia\.workspace-file-selection\.preview\.v1/);
    expect(screen.getByRole("region", { name: "Selected file export preview" })).toHaveTextContent(/README\.md/);
    expect(screen.getByRole("region", { name: "Selected file export preview" })).toHaveTextContent(/file contents omitted/i);
    expect(screen.getByRole("region", { name: "Selected file export preview" })).not.toHaveTextContent(/# Omnia/);

    fireEvent.change(screen.getByRole("combobox", { name: "Selected file export format" }), { target: { value: "markdown" } });
    expect(screen.getByRole("region", { name: "Selected file export preview" })).toHaveTextContent(/# Omnia workspace file selection/);
  });
});
