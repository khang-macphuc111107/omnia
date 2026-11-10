import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectOverviewRefreshPreview } from "./project-overview-refresh-preview";
import type { ProjectOverviewView } from "./types";

const overview: ProjectOverviewView = {
  overviewRevisionId: "overview-17",
  projectTwinRevisionId: "twin-42",
  sourceEventWatermark: 42,
  status: "current",
  title: "Omnia workspace",
  subtitle: null,
  summary: "A reviewable AI workspace.",
  goal: "Ship an evidence-first workspace",
  nonGoals: [],
  phase: "UI preview",
  milestone: "Project Twin",
  nextTask: "Review the next dependency",
  activeBranch: "main",
  workspaceRootCount: 1,
  repositoryBranch: "main",
  worktree: "clean",
  verifiedEvidence: [{ id: "evidence-1", label: "Renderer checks", status: "verified", freshnessLabel: "Fresh", sourceLabel: "Vitest" }],
  staleNodeCount: 0,
  runtimeLabel: "Browser preview",
  modelProfileId: null,
  contextRevisionId: null,
  budgetLabel: null,
  backgroundWorkLabel: null,
  approvalsLabel: null,
  attentionItems: [],
  recentChanges: [],
};

describe("project overview refresh preview", () => {
  it("keeps cosmetic refreshes from creating a material candidate", () => {
    render(<ProjectOverviewRefreshPreview projectId="project-1" overview={overview} />);

    fireEvent.click(screen.getByRole("button", { name: "Generate candidate" }));

    expect(screen.getByText("No material root selected. Cosmetic activity would not churn the overview or title.")).toBeInTheDocument();
    expect(screen.getByText("No material change")).toBeInTheDocument();
    expect(screen.getByText(/No provider request, native write, durable revision/)).toBeInTheDocument();
  });

  it("creates a deterministic candidate with pinned-field preservation and comparison", () => {
    render(<ProjectOverviewRefreshPreview projectId="project-1" overview={overview} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /Goal or scope changed/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Verified evidence changed/i }));
    fireEvent.click(screen.getByRole("button", { name: "Generate candidate" }));

    const candidate = screen.getByRole("region", { name: "Project overview refresh candidate" });
    expect(candidate).toHaveTextContent("Candidate");
    expect(candidate).toHaveTextContent("Deterministic diff preview");
    expect(candidate).toHaveTextContent("Title");
    expect(candidate).toHaveTextContent("Preserved because it is pinned");

    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(candidate).toHaveTextContent("Compare mode is renderer-local");
  });

  it("supports title-policy and pin controls without mutating the source overview", () => {
    render(<ProjectOverviewRefreshPreview projectId="project-1" overview={overview} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Automatic title changes" }), { target: { value: "locked" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Summary/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Task or milestone changed/i }));
    fireEvent.click(screen.getByRole("button", { name: "Generate candidate" }));

    const candidate = screen.getByRole("region", { name: "Project overview refresh candidate" });
    expect(candidate).toHaveTextContent("Locked");
    expect(candidate).toHaveTextContent("summary");

    fireEvent.click(screen.getByRole("button", { name: "Accept in preview" }));
    expect(screen.getByRole("status")).toHaveTextContent("Accepted in renderer preview only");

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    const resetCandidate = screen.getByRole("region", { name: "Project overview refresh candidate" });
    expect(resetCandidate).toHaveTextContent("No candidate yet");
    expect(resetCandidate).not.toHaveTextContent("Deterministic diff preview");
  });
});
