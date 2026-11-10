import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectOverview } from "./project-overview";
import type { ProjectOverviewView } from "./types";

function overview(overrides: Partial<ProjectOverviewView> = {}): ProjectOverviewView {
  return {
    overviewRevisionId: null,
    projectTwinRevisionId: null,
    sourceEventWatermark: null,
    status: "unknown",
    title: "Context preview",
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

describe("project overview context availability", () => {
  it("does not turn renderer ready health into a compiled claim", () => {
    render(
      <ProjectOverview
        projectId="project-context"
        overview={overview()}
        contextHealth="ready"
        folders={[{ state: "referenced", scope: "read-only" }]}
      />,
    );

    const root = screen.getByRole("region", { name: "Context preview" });
    expect(root).toHaveAttribute("data-context-availability", "preview");
    expect(screen.getAllByText("Referenced · not indexed").length).toBeGreaterThan(0);
    expect(screen.queryByText("Context ready")).not.toBeInTheDocument();
    expect(screen.getByText(/no native index or frozen context revision is hydrated/i)).toBeInTheDocument();
  });

  it("only surfaces compiled context when the overview carries native revision evidence", () => {
    render(
      <ProjectOverview
        projectId="project-context"
        overview={overview({
          status: "current",
          contextRevisionId: "context-17",
          sourceEventWatermark: 17,
        })}
        contextHealth="ready"
      />,
    );

    const root = screen.getByRole("region", { name: "Context preview" });
    expect(root).toHaveAttribute("data-context-availability", "verified");
    expect(screen.getAllByText("Compiled · native evidence").length).toBeGreaterThan(0);
    expect(screen.getByText(/native context revision and source watermark are available/i)).toBeInTheDocument();
  });

  it("exposes the canonical six-tab contract as expandable renderer actions", () => {
    const opened: Array<[string, string | undefined]> = [];

    render(
      <ProjectOverview
        projectId="project-tabs"
        overview={overview()}
        contextHealth="ready"
        onOpenOverviewTab={(tab, targetTab) => opened.push([tab, targetTab])}
      />,
    );

    const map = screen.getByRole("region", { name: "Canonical Project Overview tabs" });
    expect(map.querySelectorAll("[data-overview-tab]")).toHaveLength(6);
    expect(map).toHaveTextContent("Conversations");
    expect(map).toHaveTextContent("Context");
    expect(map).toHaveTextContent("Files");
    expect(map).toHaveTextContent("Memory");
    expect(map).toHaveTextContent("Skills");
    expect(map).toHaveTextContent("Settings");

    fireEvent.click(screen.getByRole("button", { name: "Context tab" }));
    expect(screen.getByRole("region", { name: "Context tab details" })).toHaveTextContent("Native gap");

    fireEvent.click(screen.getByRole("button", { name: "Open Context tab" }));
    expect(opened).toEqual([["context", "context"]]);
  });

  it("fails closed for Settings when no overview navigation callback is connected", () => {
    render(
      <ProjectOverview
        projectId="project-settings"
        overview={overview()}
        contextHealth="ready"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Settings tab" }));
    expect(screen.getByRole("region", { name: "Settings tab details" })).toHaveTextContent("Unavailable");
    expect(screen.getByRole("button", { name: "Unavailable" })).toBeDisabled();
  });
});
