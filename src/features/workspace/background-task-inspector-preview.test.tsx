import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import BackgroundTaskInspectorPreview, {
  serializeBackgroundTaskInspector,
  type BackgroundTaskInspectorItem,
} from "./background-task-inspector-preview";
import { resetPermissionSession, updatePermissionValues } from "./session-permission-contract";

const items: readonly BackgroundTaskInspectorItem[] = [
  {
    id: "goal-1",
    kind: "goal",
    title: "Ship the preview",
    owner: "You",
    state: "working",
    stage: "Planning",
    summary: "Coordinate the next UI slice.",
    detail: "Renderer-only goal projection.",
    authority: "Planning only",
    evidence: "Preview projection",
  },
  {
    id: "task-1",
    kind: "task",
    title: "Review route evidence",
    owner: "Reviewer",
    state: "needs-review",
    stage: "Review",
    summary: "Check route provenance.",
    detail: "No native receipt is attached.",
    parentId: "goal-1",
    authority: "Review suggestions",
    evidence: "Synthetic checklist",
  },
];

describe("Background Task Inspector Preview", () => {
  it("renders the work graph and keeps authority boundaries visible", () => {
    render(<BackgroundTaskInspectorPreview items={items} />);

    expect(screen.getByRole("region", { name: "Background task inspector preview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Goals, tasks, agents/i })).toBeInTheDocument();
    expect(screen.getByText(/No native task scheduler/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ship the preview" })).toBeInTheDocument();
  });

  it("filters records, reviews a selected record, and rehearses handoff without dispatch", () => {
    render(<BackgroundTaskInspectorPreview items={items} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search background task records" }), { target: { value: "route" } });
    const list = screen.getByRole("list", { name: "1 background task inspector record" });
    expect(list).toHaveTextContent("Review route evidence");
    expect(list).not.toHaveTextContent("Ship the preview");

    fireEvent.click(within(list).getByRole("listitem", { name: /Review route evidence/i }));
    fireEvent.click(screen.getByRole("button", { name: /Mark reviewed/i }));
    expect(screen.getByText(/Reviewed in renderer session/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Rehearse handoff/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/no agent was spawned/i);
  });

  it("serializes a portable JSON and Markdown projection", () => {
    expect(serializeBackgroundTaskInspector(items, "json")).toMatch(/omnia\.background-task-inspector\.preview\.v1/);
    expect(serializeBackgroundTaskInspector(items, "markdown")).toMatch(/# Omnia background task inspector preview/);
  });

  it("shows the shared permission policy on approval rehearsal cards without granting authority", () => {
    resetPermissionSession();
    updatePermissionValues({ "network.public": "allow", "files.read": "deny" });
    render(<BackgroundTaskInspectorPreview items={[{
      id: "approval-1",
      kind: "approval",
      title: "Provider route approval",
      owner: "You",
      state: "needs-review",
      stage: "Access",
      summary: "Review a planned route.",
      detail: "No native approval exists.",
      authority: "Preview decision",
      evidence: "Permission rehearsal",
    }]} />);

    const policy = screen.getByRole("region", { name: "Approval permission policy preview" });
    expect(policy).toHaveTextContent("Custom policy");
    expect(policy).toHaveTextContent(/cannot convert the preview into authority/i);
    resetPermissionSession();
  });
});
