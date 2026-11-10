import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildProjectContextAvailability } from "./project-context-availability-contract";
import { projectOverviewFromProject } from "./project-catalog";
import { ProjectReadonlyLedger } from "./project-readonly-ledger";
import { useWorkspaceStore } from "./store";

describe("ProjectReadonlyLedger", () => {
  it("surfaces read-only mission, provenance, and scope facts without a mutation path", () => {
    const source = useWorkspaceStore.getState().projects[0]!;
    const project = {
      ...source,
      overview: {
        ...projectOverviewFromProject(source),
        overviewRevisionId: "overview-preview-7",
        projectTwinRevisionId: "twin-preview-2",
        sourceEventWatermark: 14,
        status: "candidate" as const,
        goal: "Keep the project boundary observable",
        phase: "UI wave 2",
        milestone: "Read-only deck",
        nextTask: "Review the native gap",
        contextRevisionId: "context-preview-4",
        attentionItems: ["Confirm native receipt coverage"],
        repositoryBranch: "codex/preview",
        worktree: "renderer-only",
      },
    };
    const availability = buildProjectContextAvailability({
      health: project.contextHealth,
      folders: project.folders,
    });

    render(
      <ProjectReadonlyLedger
        project={project}
        contextAvailability={availability}
        chatCount={3}
        memoryCount={2}
        skillCount={1}
      />,
    );

    const ledger = screen.getByRole("region", { name: "Project evidence ledger" });
    expect(ledger).toHaveAttribute("data-ledger-status", "candidate");
    expect(within(ledger).getByText("Keep the project boundary observable")).toBeInTheDocument();
    expect(within(ledger).getByText("UI wave 2")).toBeInTheDocument();
    expect(within(ledger).getByText("Review the native gap")).toBeInTheDocument();
    expect(within(ledger).getByText("Automatic route")).toBeInTheDocument();
    expect(within(ledger).getByText("Candidate projection")).toBeInTheDocument();
    expect(within(ledger).getByText("3")).toBeInTheDocument();
    expect(within(ledger).getByText("2")).toBeInTheDocument();
    expect(within(ledger).getAllByText("1").length).toBeGreaterThanOrEqual(1);
    expect(within(ledger).getByText(/No write path/i)).toBeInTheDocument();
    expect(within(ledger).getByText(/does not read workspace files/i)).toBeInTheDocument();
  });

  it("keeps missing overview facts visibly unknown and reports renderer context evidence", () => {
    const project = useWorkspaceStore.getState().projects[0]!;
    const availability = buildProjectContextAvailability({
      health: "ready",
      folders: project.folders,
    });
    const { overview: _ignoredOverview, ...projectWithoutOverview } = project;

    render(
      <ProjectReadonlyLedger
        // `exactOptionalPropertyTypes` keeps the destructured optional field
        // as an explicit `undefined` in the inferred rest type. Casting the
        // omission back to the domain shape preserves the runtime fixture:
        // overview is absent, not present with an undefined value.
        project={{ ...projectWithoutOverview, contextHealth: "ready" } as typeof project}
        contextAvailability={availability}
        chatCount={0}
        memoryCount={0}
        skillCount={0}
      />,
    );

    const ledger = screen.getByRole("region", { name: "Project evidence ledger" });
    expect(within(ledger).getAllByText("Unknown").length).toBeGreaterThanOrEqual(3);
    expect(within(ledger).getAllByText("Referenced · not indexed").length).toBeGreaterThanOrEqual(1);
    expect(ledger).toHaveAttribute("data-ledger-context", "preview");
    expect(within(ledger).getByText(/No blocking decision is hydrated/i)).toBeInTheDocument();
  });
});
