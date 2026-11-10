import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectMissionOverview } from "./project-mission-overview";
import type { ProjectOverviewView } from "./types";

function overview(overrides: Partial<ProjectOverviewView> = {}): ProjectOverviewView {
  return {
    overviewRevisionId: null,
    projectTwinRevisionId: null,
    sourceEventWatermark: null,
    status: "unknown",
    title: "Mission preview",
    subtitle: null,
    summary: "Renderer-local project overview.",
    goal: null,
    nonGoals: [],
    phase: null,
    milestone: null,
    nextTask: null,
    activeBranch: null,
    workspaceRootCount: 0,
    repositoryBranch: null,
    worktree: null,
    verifiedEvidence: [],
    staleNodeCount: null,
    runtimeLabel: null,
    modelProfileId: null,
    contextRevisionId: null,
    budgetLabel: null,
    backgroundWorkLabel: null,
    approvalsLabel: null,
    attentionItems: [],
    recentChanges: [],
    ...overrides,
  };
}

describe("ProjectMissionOverview", () => {
  it("keeps the mission boundary explicit when native overview facts are absent", () => {
    render(<ProjectMissionOverview projectId="project-preview" overview={overview()} />);

    const root = screen.getByRole("region", { name: "Project mission overview" });
    expect(root).toHaveAttribute("data-mission-status", "unknown");
    expect(screen.getByText("Primary goal")).toBeInTheDocument();
    expect(screen.getAllByText("Unknown").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/renderer-local mission preview only/i)).toBeInTheDocument();
    expect(screen.getByText(/no non-goal facts are hydrated/i)).toBeInTheDocument();
  });

  it("surfaces the objective, phase, next task, non-goals, and attention items", () => {
    render(
      <ProjectMissionOverview
        projectId="project-current"
        overview={overview({
          overviewRevisionId: "overview-22",
          status: "current",
          goal: "Ship an evidence-bound project workspace",
          phase: "Foundation",
          milestone: "Chat Complete preview",
          nextTask: "Verify the renderer/native boundary",
          nonGoals: ["No unapproved execution", "No hidden indexing"],
          attentionItems: ["Confirm native receipt coverage", "Review stale source links"],
        })}
      />,
    );

    const root = screen.getByRole("region", { name: "Project mission overview" });
    expect(root).toHaveAttribute("data-mission-status", "current");
    expect(screen.getByText("Ship an evidence-bound project workspace")).toBeInTheDocument();
    expect(screen.getByText("Foundation")).toBeInTheDocument();
    expect(screen.getByText(/milestone: chat complete preview/i)).toBeInTheDocument();
    expect(screen.getByText("Verify the renderer/native boundary")).toBeInTheDocument();
    expect(screen.getByText("No unapproved execution")).toBeInTheDocument();
    expect(screen.getAllByText("Confirm native receipt coverage").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/projection of the named overview revision/i)).toBeInTheDocument();
  });
});
