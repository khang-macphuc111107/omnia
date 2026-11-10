import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ProjectPlanningPreview, { buildPlanningInsights, parsePlanningImport } from "./project-planning-preview";
import type { ConversationView, ProjectView } from "./types";

const project: ProjectView = {
  id: "planning-preview-project",
  name: "Omnia UI",
  description: "A project planning fixture.",
  accent: "#2563eb",
  instructions: "",
  modelProfileId: "auto",
  conversationCount: 0,
  contextHealth: "not-compiled",
  pinned: false,
  folders: [],
};

const emptyChat: ConversationView = {
  id: "chat-empty", activeBranchId: "branch-one", title: "Planning chat", excerpt: "",
  updatedAt: "2026-09-24T00:00:00.000Z", updatedLabel: "Today",
  projectId: project.id, projectName: project.name, pinned: false, archived: false,
  hasDraft: false, unread: false, runState: null, draft: "", messages: [],
};

describe("ProjectPlanningPreview", () => {
  it("shows the roadmap and keeps native boundaries explicit", () => {
    render(<ProjectPlanningPreview project={project} />);

    expect(screen.getByRole("heading", { name: "Project planning studio" })).toBeInTheDocument();
    expect(screen.getByText(/Turn Omnia UI into a reviewable/i)).toBeInTheDocument();
    expect(screen.getByText(/Native goals, milestones, task leases/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm goal and non-goals" })).toBeInTheDocument();
    expect(screen.getByText("Critical path insights")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Critical path step 1" })).toHaveAttribute("title", "Confirm goal and non-goals");
  });

  it("supports task filtering, status advancement, and adding a local task", () => {
    render(<ProjectPlanningPreview project={project} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Project plan task filter" }), { target: { value: "active" } });
    expect(screen.getByRole("button", { name: /Map project scope and constraints/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Map project scope and constraints/i }));
    fireEvent.click(screen.getByRole("button", { name: /Advance to Done/i }));
    expect(screen.getByText(/is done in the renderer preview/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Project plan task filter" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("textbox", { name: "New project plan task title" }), { target: { value: "Review the exported plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    expect(screen.getByRole("button", { name: /Review the exported plan/i })).toBeInTheDocument();
  });

  it("filters roadmap, DAG, and acceptance rows by phase and task metadata", () => {
    render(<ProjectPlanningPreview project={project} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Project plan task search" }), { target: { value: "Architect" } });
    expect(screen.getByRole("button", { name: /Draft architecture and interface blueprint/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm goal and non-goals" })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Project plan task search" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Project plan phase filter" }), { target: { value: "phase-evidence" } });
    expect(screen.getByRole("button", { name: /Attach acceptance evidence/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Draft architecture and interface blueprint/i })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Acceptance" }));
    expect(screen.getByText(/Each acceptance criterion points to a source/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Project plan task search" }), { target: { value: "Architect" } });
    expect(screen.getByText(/No acceptance checks match the current filters/i)).toBeInTheDocument();
  });

  it("edits selected task metadata and dependency edges in the renderer session", () => {
    render(<ProjectPlanningPreview project={project} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit details" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Selected task owner" }), { target: { value: "Reviewer" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Selected task acceptance" }), { target: { value: "Reviewer can observe the dependency-ready state." } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Confirm goal and non-goals/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Reviewer can observe the dependency-ready state.")).toBeInTheDocument();
    expect(screen.getByText(/Updated “Map project scope and constraints”/i)).toBeInTheDocument();
  });

  it("keeps dependency editing acyclic", () => {
    render(<ProjectPlanningPreview project={project} />);

    fireEvent.click(screen.getByRole("button", { name: "Confirm goal and non-goals" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit details" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Map project scope and constraints/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    expect(screen.getByText(/would create a cycle/i)).toBeInTheDocument();
  });

  it("switches to DAG and acceptance views", () => {
    render(<ProjectPlanningPreview project={project} />);

    fireEvent.click(screen.getByRole("tab", { name: "Task DAG" }));
    expect(screen.getByText(/Critical path preview/i)).toBeInTheDocument();
    expect(screen.getByText(/Depends on task-intent/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Acceptance" }));
    expect(screen.getByText(/What “done” needs to prove/i)).toBeInTheDocument();
    expect(screen.getByText(/A user-readable objective and three non-goals are visible/i)).toBeInTheDocument();
  });

  it("exposes a renderer-local JSON or Markdown export preview", () => {
    render(<ProjectPlanningPreview project={project} />);

    fireEvent.click(screen.getByRole("button", { name: "Export preview" }));
    const region = screen.getByRole("region", { name: "Project planning export preview" });
    expect(within(region).getByRole("code")).toHaveTextContent(/omnia\.project-planning\.preview\.v1/i);
    fireEvent.change(within(region).getByRole("combobox", { name: "Project planning export format" }), { target: { value: "markdown" } });
    expect(within(region).getByRole("code")).toHaveTextContent(/# Omnia UI planning preview/i);
    expect(within(region).getByText(/does not persist a plan/i)).toBeInTheDocument();
  });

  it("links plan view tabs to their active panels and supports roving keyboard navigation", () => {
    render(<ProjectPlanningPreview project={project} />);

    const tablist = screen.getByRole("tablist", { name: "Project plan views" });
    const roadmapTab = within(tablist).getByRole("tab", { name: "Roadmap" });
    const dagTab = within(tablist).getByRole("tab", { name: "Task DAG" });
    expect(roadmapTab).toHaveAttribute("aria-controls", "project-plan-panel-roadmap");
    expect(roadmapTab).toHaveAttribute("tabindex", "0");
    expect(dagTab).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel", { name: "Roadmap" })).toHaveAttribute("aria-labelledby", roadmapTab.id);

    roadmapTab.focus();
    fireEvent.keyDown(roadmapTab, { key: "ArrowRight" });
    expect(dagTab).toHaveFocus();
    expect(dagTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Task DAG" })).toHaveAttribute("aria-labelledby", dagTab.id);
  });

  it("scrolls only intentional Plan view changes into view while preserving keyboard focus", () => {
    const previousScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    try {
      const { rerender } = render(<ProjectPlanningPreview project={project} />);
      expect(scrollIntoView).not.toHaveBeenCalled();
      rerender(<ProjectPlanningPreview project={project} />);
      expect(scrollIntoView).not.toHaveBeenCalled();

      const tablist = screen.getByRole("tablist", { name: "Project plan views" });
      fireEvent.click(within(tablist).getByRole("tab", { name: "Blueprint" }));
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
      expect(screen.getByRole("tabpanel", { name: "Blueprint" })).toBeInTheDocument();

      const blueprintTab = within(tablist).getByRole("tab", { name: "Blueprint" });
      blueprintTab.focus();
      fireEvent.keyDown(blueprintTab, { key: "ArrowRight" });
      expect(within(tablist).getByRole("tab", { name: "Acceptance" })).toHaveFocus();
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
    } finally {
      if (previousScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", previousScrollIntoView);
      else delete (HTMLElement.prototype as { scrollIntoView?: typeof HTMLElement.prototype.scrollIntoView }).scrollIntoView;
    }
  });

  it("stages a JSON import, applies it locally, and can undo the revision", async () => {
    render(<ProjectPlanningPreview project={project} />);

    const input = screen.getByRole("textbox", { name: "New project plan task title" });
    expect(input).toBeInTheDocument();
    const importInput = screen.getByLabelText("Choose project plan import file") as HTMLInputElement;
    const payload = JSON.stringify({
      schema: "omnia.project-planning.preview.v1",
      objective: "Imported planning objective",
      phases: [{
        id: "phase-imported",
        title: "Imported phase",
        objective: "Imported objective",
        window: "Now",
        status: "active",
        tasks: [{
          id: "task-imported",
          title: "Imported task",
          status: "planned",
          owner: "Reviewer",
          dependsOn: [],
          acceptance: "Imported acceptance",
          artifact: "Imported artifact",
          risk: null,
        }],
      }],
    });
    const file = new File([payload], "planning.json", { type: "application/json" });
    fireEvent.change(importInput, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole("region", { name: "Project planning import preview" })).toBeInTheDocument());
    expect(screen.getByText(/Imported planning objective/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply to preview" }));
    expect(screen.getByText("Imported planning objective")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Undo project plan change/i }));
    expect(screen.getByText(/Turn Omnia UI into a reviewable/i)).toBeInTheDocument();
  });

  it("parses a portable Markdown roadmap into a renderer-local import preview", () => {
    const preview = parsePlanningImport(
      "# Omnia UI planning preview\n\n## Objective\n\nShip a calmer planning surface.\n\n## Roadmap\n\n### Foundation · Active\n- [x] Confirm scope (Done; You)\n- [ ] Draft handoff (Planned; Reviewer)\n",
      "roadmap.md",
      "Omnia UI",
    );

    expect(preview?.format).toBe("markdown");
    expect(preview?.plan.objective).toBe("Ship a calmer planning surface.");
    expect(preview?.plan.phases[0]?.tasks).toHaveLength(2);
    expect(preview?.warnings.join(" ")).toMatch(/without dependency edges/i);
  });

  it("surfaces invalid JSON dependency edges instead of treating them as a valid DAG", () => {
    const payload = {
      objective: "Review imported graph integrity",
      phases: [{
        id: "phase-imported",
        title: "Imported graph",
        tasks: [
          { id: "task-a", title: "A", dependsOn: ["task-a", "task-missing", "task-missing"] },
          { id: "task-a", title: "A duplicate", dependsOn: [] },
          { id: "task-b", title: "B", dependsOn: ["task-a"] },
        ],
      }],
    };

    const preview = parsePlanningImport(JSON.stringify(payload), "invalid-plan.json", "Omnia UI");

    expect(preview).not.toBeNull();
    expect(preview?.warnings.join(" ")).toMatch(/duplicate task ID/i);
    expect(preview?.warnings.join(" ")).toMatch(/unknown task/i);
    expect(preview?.warnings.join(" ")).toMatch(/self-dependency/i);
    expect(preview?.warnings.join(" ")).toMatch(/duplicate dependency edge/i);
    expect(buildPlanningInsights(preview!.plan)).toMatchObject({
      unknownDependencyCount: 2,
      selfDependencyCount: 1,
      duplicateDependencyCount: 1,
      cycleDetected: true,
    });
  });

  it("marks imported dependency cycles for review", () => {
    const preview = parsePlanningImport(JSON.stringify({
      objective: "Cycle fixture",
      phases: [{
        id: "phase-cycle",
        title: "Cycle",
        tasks: [
          { id: "task-a", title: "A", dependsOn: ["task-b"] },
          { id: "task-b", title: "B", dependsOn: ["task-a"] },
        ],
      }],
    }), "cycle.json", "Omnia UI");

    expect(preview?.warnings.join(" ")).toMatch(/dependency cycle/i);
    expect(buildPlanningInsights(preview!.plan).cycleDetected).toBe(true);
  });

  it("emits a bounded handoff seed for the selected task", () => {
    let received: { taskId: string; taskTitle: string; phaseTitle: string; status: string } | null = null;
    render(<ProjectPlanningPreview project={project} onPrepareHandoff={(seed) => { received = seed; }} />);

    fireEvent.click(screen.getByRole("button", { name: "Prepare handoff for selected task" }));

    expect(received).toMatchObject({
      taskId: "task-scope",
      taskTitle: "Map project scope and constraints",
      phaseTitle: "Foundation",
      status: "active",
    });
    expect(received).not.toBeNull();
  });

  it("lets the user choose only an empty Project Chat and stages the selected task without sending", () => {
    const received: Array<{ taskId: string; destination: string }> = [];
    render(<ProjectPlanningPreview
      project={project}
      conversations={[{ ...emptyChat, id: "chat-occupied", title: "My existing draft", draft: "Keep this", hasDraft: true }, emptyChat]}
      onPrepareChatDraft={(seed, destination) => { received.push({ taskId: seed.taskId, destination }); return "prepared"; }}
    />);
    const destination = screen.getByRole("combobox", { name: "Chat draft destination" });
    expect(destination).toHaveValue(emptyChat.id);
    expect(within(destination).getByRole("option", { name: /My existing draft/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Prepare Chat draft" }));
    expect(received).toEqual([{ taskId: "task-scope", destination: emptyChat.id }]);
    expect(screen.getByText(/No provider request was sent/i)).toBeInTheDocument();
  });

  it("offers a new Chat setup carrying the selected task without creating it immediately", () => {
    const received: string[] = [];
    render(<ProjectPlanningPreview project={project} onPrepareChatDraft={() => "unavailable"} onCreateChatDraft={(seed) => received.push(seed.taskTitle)} />);
    fireEvent.click(screen.getByRole("button", { name: "New Chat with task draft" }));
    expect(received).toEqual(["Map project scope and constraints"]);
    expect(screen.getByText(/No Chat or run was created yet/i)).toBeInTheDocument();
  });

  it("keeps New Chat setup visible when the host cannot open an existing Chat", () => {
    const received: string[] = [];
    render(<ProjectPlanningPreview project={project} onCreateChatDraft={(seed) => received.push(seed.taskTitle)} />);

    expect(screen.queryByRole("combobox", { name: "Chat draft destination" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New Chat with task draft" }));

    expect(received).toEqual(["Map project scope and constraints"]);
    expect(screen.getByText(/No Chat or run was created yet/i)).toBeInTheDocument();
  });
});
