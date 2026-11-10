import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProjectIdeProblemsPreview } from "./project-ide-problems-preview";

describe("Project IDE problems preview", () => {
  it("filters synthetic diagnostics by severity, scope, and search", () => {
    render(<ProjectIdeProblemsPreview selectedPath="src/main.ts" onOpenFile={vi.fn()} />);

    expect(screen.getByText("Route union is missing the planned settings surface.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Problem severity filter" }), { target: { value: "error" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.change(screen.getByRole("combobox", { name: "Problem scope filter" }), { target: { value: "current-file" } });
    expect(screen.getByText("No matching preview problems")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Problem severity filter" }), { target: { value: "all" } });
    expect(screen.getByText("Greeting helper has no renderer-local usage in this preview.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search preview problems" }), { target: { value: "greeting" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("opens the selected problem in the preview file and keeps the boundary truthful", () => {
    const onOpenFile = vi.fn();
    render(<ProjectIdeProblemsPreview selectedPath="src/main.ts" onOpenFile={onOpenFile} />);

    fireEvent.click(screen.getByRole("button", { name: "Open OMNIA-ROUTE-001 in src/router.ts" }));
    expect(onOpenFile).toHaveBeenCalledWith("src/router.ts");
    expect(screen.getByRole("status")).toHaveTextContent(/opened at src\/router\.ts:1:22/i);
    expect(screen.getByText(/no compiler, linter, test runner, terminal/i)).toBeInTheDocument();
  });

  it("supports renderer-local diagnostic triage and filtering", () => {
    render(<ProjectIdeProblemsPreview selectedPath="src/main.ts" onOpenFile={vi.fn()} />);

    expect(screen.getByRole("complementary", { name: "Selected preview diagnostic" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    expect(screen.getByRole("status")).toHaveTextContent(/marked reviewed in preview/i);
    expect(screen.getAllByText("Reviewed").length).toBeGreaterThanOrEqual(1);

    fireEvent.change(screen.getByRole("combobox", { name: "Problem triage filter" }), { target: { value: "reviewed" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Route union is missing the planned settings surface.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Suppress in preview" }));
    expect(screen.getByRole("status")).toHaveTextContent(/suppressed in preview/i);
    fireEvent.change(screen.getByRole("combobox", { name: "Problem triage filter" }), { target: { value: "suppressed" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText(/review state is renderer-local/i)).toBeInTheDocument();
  });
});
