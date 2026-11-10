import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectAdvancedSettingsPreview } from "./project-advanced-settings-preview";
import type { ProjectView } from "./types";

const project: ProjectView = {
  id: "advanced-settings-project",
  name: "Omnia Lab",
  description: "A focused workspace for implementation and research.",
  accent: "#2563eb",
  instructions: "Keep changes inspectable.",
  modelProfileId: "auto",
  conversationCount: 0,
  contextHealth: "not-compiled",
  pinned: false,
  folders: [],
};

describe("ProjectAdvancedSettingsPreview", () => {
  it("shows a rich project policy preview with an explicit boundary", () => {
    render(<ProjectAdvancedSettingsPreview project={project} />);

    expect(screen.getByRole("region", { name: "Advanced Project settings preview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Advanced settings" })).toBeInTheDocument();
    expect(screen.getAllByText(/Preview only/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/never update Project metadata, SQLite/i)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Project icon" })).toBeInTheDocument();
  });

  it("applies a preset and keeps the typed vector visible in the portable preview", () => {
    render(<ProjectAdvancedSettingsPreview project={project} />);

    fireEvent.click(screen.getByRole("button", { name: /Coder workspace/i }));
    expect(screen.getByRole("combobox", { name: /Preferred route/i })).toHaveValue("quality-first");
    expect(screen.getByRole("combobox", { name: /Workspace context/i })).toHaveValue("selected-files");
    expect(screen.getByLabelText("Project accent color")).toHaveValue("#38bdf8");
    const preview = screen.getByRole("region", { name: "Import and export advanced Project settings" });
    expect(within(preview).getByText(/omnia\.project-advanced-settings-preview\.v1/i)).toBeInTheDocument();
    expect(within(preview).getByText(/renderer-session/i)).toBeInTheDocument();
  });

  it("supports reversible edits and preview archive intent", () => {
    render(<ProjectAdvancedSettingsPreview project={project} />);

    const route = screen.getByRole("combobox", { name: /Preferred route/i });
    fireEvent.change(route, { target: { value: "local-private" } });
    expect(route).toHaveValue("local-private");
    fireEvent.click(screen.getByRole("button", { name: "Undo advanced Project settings" }));
    expect(route).toHaveValue("balanced");
    fireEvent.click(screen.getByRole("button", { name: "Redo advanced Project settings" }));
    expect(route).toHaveValue("local-private");

    fireEvent.click(screen.getByRole("button", { name: /Preview archive/i }));
    expect(screen.getByRole("button", { name: /Restore preview/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Archive intent preview/i)).toBeInTheDocument();
  });

  it("resets a draft back to defaults without changing the Project input", () => {
    render(<ProjectAdvancedSettingsPreview project={project} />);

    fireEvent.click(screen.getByRole("button", { name: /Creative studio/i }));
    expect(screen.getByRole("combobox", { name: /Memory behavior/i })).toHaveValue("off");
    fireEvent.click(screen.getByRole("button", { name: "Reset advanced Project settings" }));
    expect(screen.getByRole("combobox", { name: /Memory behavior/i })).toHaveValue("propose");
    expect(screen.getByText(project.name)).toBeInTheDocument();
  });
});
