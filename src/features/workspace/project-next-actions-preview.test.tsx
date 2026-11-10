import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  buildProjectDeckNextActions,
  ProjectNextActionsPreview,
} from "./project-next-actions-preview";
import { projectOverviewFromProject } from "./project-catalog";
import { useWorkspaceStore } from "./store";

describe("ProjectNextActionsPreview", () => {
  it("derives a bounded queue from visible project facts and marks host gaps", () => {
    const state = useWorkspaceStore.getState();
    const sourceProject = state.projects[0]!;
    const overview = sourceProject.overview ?? projectOverviewFromProject(sourceProject);
    const project = {
      ...sourceProject,
      folders: [],
      contextHealth: "missing-access" as const,
      overview: {
        ...overview,
        nextTask: "Review the project boundary",
        phase: "UI wave",
        attentionItems: ["Confirm native receipt coverage"],
      },
    };
    const actions = buildProjectDeckNextActions({ project, conversations: [] });

    expect(actions).toHaveLength(5);
    expect(actions[0]).toMatchObject({ id: "workspace-access", status: "attention", target: "access" });
    expect(actions.some((action) => action.id === "overview-next-task")).toBe(true);
    expect(actions.some((action) => action.id === "model-route")).toBe(true);
    expect(actions.every((action) => action.detail.includes("host callback unavailable") || !action.requiresHostCallback)).toBe(true);
  });

  it("stages renderer-local navigation and keeps completion reversible", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    const onNavigate = vi.fn();
    const onOpenChat = vi.fn();
    const conversations = state.conversations.filter((conversation) => conversation.projectId === project.id).slice(0, 1);

    render(
      <ProjectNextActionsPreview
        project={project}
        conversations={conversations}
        onNavigate={onNavigate}
        onOpenChat={onOpenChat}
      />,
    );

    const queue = screen.getByRole("region", { name: /next actions/i });
    expect(within(queue).getByText(/Generated from visible Project facts/i)).toBeInTheDocument();
    const firstRow = within(queue).getAllByRole("article")[0]!;
    const firstLabel = within(firstRow).getByRole("button", { name: /Stage/i });
    fireEvent.click(firstLabel);
    expect(onNavigate).toHaveBeenCalled();
    expect(within(queue).getByRole("status")).toHaveTextContent(/Staged/i);

    const complete = within(firstRow).getByRole("button", { name: /Mark .* complete/i });
    fireEvent.click(complete);
    expect(complete).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(firstRow).getByRole("button", { name: /Reopen/i }));
    expect(within(firstRow).getByRole("button", { name: /Mark .* complete/i })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(within(queue).getByRole("button", { name: "Preview brief" }));
    const brief = within(queue).getByRole("region", { name: "Project next action brief" });
    expect(within(brief).getByText(/Renderer-local preview only/i)).toBeInTheDocument();
    expect(within(brief).getByRole("button", { name: "Download .md" })).toBeInTheDocument();
  });

  it("filters attention and completed actions without implying a runner", () => {
    const state = useWorkspaceStore.getState();
    const project = { ...state.projects[0]!, folders: [], contextHealth: "missing-access" as const };
    render(<ProjectNextActionsPreview project={project} conversations={[]} onNavigate={vi.fn()} />);

    const queue = screen.getByRole("region", { name: /next actions/i });
    fireEvent.change(within(queue).getByRole("combobox", { name: "Filter project next actions" }), { target: { value: "attention" } });
    expect(within(queue).getAllByRole("article").length).toBeGreaterThan(0);
    expect(within(queue).getByText(/No provider request, filesystem read/i)).toBeInTheDocument();
  });
});
