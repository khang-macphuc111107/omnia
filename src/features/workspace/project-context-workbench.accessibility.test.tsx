import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectContextWorkbench } from "./project-context-workbench";
import { projectOverviewFromProject } from "./project-catalog";
import type { ProjectView } from "./types";

const project: ProjectView = {
  id: "context-a11y-project",
  name: "Accessibility fixture",
  description: "",
  accent: "#2563eb",
  instructions: "Prefer explicit evidence.",
  modelProfileId: "auto",
  conversationCount: 0,
  contextHealth: "ready",
  pinned: false,
  folders: [],
};

describe("ProjectContextWorkbench accessibility", () => {
  it("links its source tabs to the panel and supports roving keyboard navigation", () => {
    render(<ProjectContextWorkbench project={project} />);

    const region = screen.getByRole("region", { name: "Project Context" });
    const tablist = within(region).getByRole("tablist", { name: "Project context sources" });
    const tabs = within(tablist).getAllByRole("tab");
    const foldersTab = within(tablist).getByRole("tab", { name: /Workspace folders/i });
    const instructionsTab = within(tablist).getByRole("tab", { name: /Project instructions/i });

    expect(foldersTab).toHaveAttribute("aria-controls", "project-context-panel-folders");
    expect(foldersTab).toHaveAttribute("tabindex", "0");
    expect(instructionsTab).toHaveAttribute("tabindex", "-1");
    expect(within(region).getByRole("tabpanel", { name: /Workspace folders/i })).toHaveAttribute(
      "aria-labelledby",
      foldersTab.id,
    );

    foldersTab.focus();
    fireEvent.keyDown(foldersTab, { key: "ArrowRight" });

    expect(instructionsTab).toHaveFocus();
    expect(instructionsTab).toHaveAttribute("aria-selected", "true");
    expect(foldersTab).toHaveAttribute("tabindex", "-1");
    expect(tabs).toHaveLength(4);
  });

  it("does not present a folder ready hint as indexed without native evidence", () => {
    render(
      <ProjectContextWorkbench
        project={{
          ...project,
          folders: [
            {
              id: "folder-ready-hint",
              displayName: "Workspace",
              canonicalPath: "C:\\workspace",
              state: "ready",
              scope: "read-only",
              fileCount: null,
              chunkCount: null,
              lastIndexedAt: null,
              localOnly: true,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Ready · native evidence unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Indexed", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText(/Folder scope or indexing state still needs native evidence/i)).toBeInTheDocument();
  });

  it("exposes a current Project overview revision without granting provider dispatch", () => {
    render(
      <ProjectContextWorkbench
        project={{
          ...project,
          overview: {
            ...projectOverviewFromProject(project),
            status: "current",
            contextRevisionId: "ctx-17",
            sourceEventWatermark: 17,
          },
        }}
      />,
    );

    const region = screen.getByRole("region", { name: "Project Context" });
    expect(within(region).getByText("Compiled · native evidence")).toBeInTheDocument();
    fireEvent.click(within(region).getByRole("button", { name: "Show details" }));
    expect(within(region).getByText(/read verified, compile verified, dispatch unavailable/)).toBeInTheDocument();
  });
});
