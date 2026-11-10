import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GoalSnapshot } from "@/lib/desktop";
import { WorkflowPanel, WorkflowPanelView } from "./workflow-panel";
import { WorkflowController, type WorkflowApi } from "./workflow-controller";
import { goalSnapshot } from "./workflow-test-fixtures";

function nativeController() {
  let goal = goalSnapshot();
  const api: WorkflowApi = {
    available: () => true, listGoals: vi.fn(async () => [goal.goal]), readGoal: vi.fn(async () => goal), readGoalRevision: vi.fn(async () => goal.currentRevision), listTasks: vi.fn(async () => []),
    createGoal: vi.fn(async (request): Promise<GoalSnapshot> => { goal = { ...goal, goal: { ...goal.goal, title: request.title, description: request.description ?? null, status: "draft" } }; return goal; }),
    createGoalRevision: vi.fn(async (request) => { const payload = JSON.parse(request.payloadJson); goal = { ...goal, goal: { ...goal.goal, title: payload.title, description: payload.description, acceptanceCriteriaJson: JSON.stringify(payload.acceptanceCriteria), metadataJson: JSON.stringify(payload.metadata), roadmapJson: JSON.stringify(payload.roadmap) } }; return goal; }),
    updateGoalStatus: vi.fn(async (request) => { goal = { ...goal, goal: { ...goal.goal, status: request.status } }; return goal; }),
    readTask: vi.fn(async () => { throw new Error("No task fixture"); }), createTask: vi.fn(async () => { throw new Error("No task fixture"); }), createTaskRevision: vi.fn(async () => { throw new Error("No task fixture"); }), updateTaskStatus: vi.fn(async () => { throw new Error("No task fixture"); }),
  };
  return { api, controller: new WorkflowController(api, { sessionId: "session_context" }) };
}

describe("workflow product panel", () => {
  it("shows native unavailability in browser preview with no invented goals", async () => {
    render(<WorkflowPanel sessionId="session_preview" />);
    expect(await screen.findByText(/requires the Tauri desktop runtime/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New goal" })).toBeDisabled();
    expect(screen.getByText(/no native conversation link/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ship evidence/i })).not.toBeInTheDocument();
  });

  it("loads the selected native goal and exposes evidence, remaining work and scope", async () => {
    const { controller, api } = nativeController();
    render(<WorkflowPanelView controller={controller} />);
    fireEvent.click(await screen.findByRole("button", { name: /ship evidence.*active/i }));
    expect(await screen.findByRole("heading", { name: "Ship evidence" })).toBeInTheDocument();
    expect(screen.getByText("Handles failures")).toBeInTheDocument();
    expect(screen.getByText("0 unresolved failures")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Remaining work" })).toBeInTheDocument();
    expect(screen.getByText(/stored plans.*do not dispatch/i)).toBeInTheDocument();
    expect(api.updateGoalStatus).not.toHaveBeenCalled();
  });

  it("creates a native draft only after an explicit valid submit", async () => {
    const { controller, api } = nativeController();
    render(<WorkflowPanelView controller={controller} />);
    await screen.findByRole("button", { name: /ship evidence.*active/i });
    fireEvent.click(screen.getByRole("button", { name: "New goal" }));
    expect(api.createGoal).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Goal title"), { target: { value: "New native goal" } });
    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "Direct evidence" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft goal" }));
    expect(await screen.findByRole("heading", { name: "New native goal" })).toBeInTheDocument();
    expect(api.createGoal).toHaveBeenCalledTimes(1);
    expect(api.updateGoalStatus).not.toHaveBeenCalled();
  });

  it("retains invalid form values, announces the failure and supports cancel", async () => {
    const { controller, api } = nativeController();
    render(<WorkflowPanelView controller={controller} />);
    await screen.findByRole("button", { name: /ship evidence.*active/i });
    fireEvent.click(screen.getByRole("button", { name: "New goal" }));
    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "Keep this draft" } });
    fireEvent.submit(screen.getByRole("form", { name: "Create goal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/title/i);
    expect(screen.getByLabelText("Objective")).toHaveValue("Keep this draft");
    expect(api.createGoal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel editing" }));
    expect(screen.queryByRole("form", { name: "Create goal" })).not.toBeInTheDocument();
  });

  it("records criteria and reports explicitly without dispatch or automatic completion", async () => {
    const { controller, api } = nativeController();
    render(<WorkflowPanelView controller={controller} />);
    fireEvent.click(await screen.findByRole("button", { name: /ship evidence.*active/i }));
    await screen.findByRole("heading", { name: "Ship evidence" });
    fireEvent.click(screen.getByRole("button", { name: "Edit criterion 1" }));
    fireEvent.change(screen.getByLabelText("Evidence references"), { target: { value: "checks.json" } });
    fireEvent.change(screen.getByLabelText("Criterion status"), { target: { value: "done" } });
    fireEvent.click(screen.getByRole("button", { name: "Save criterion" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit criterion 1" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add report" }));
    fireEvent.change(screen.getByLabelText("Report summary"), { target: { value: "Renderer checked" } });
    fireEvent.change(screen.getByLabelText("Report evidence references"), { target: { value: "checks.json" } });
    fireEvent.change(screen.getByLabelText("Remaining work"), { target: { value: "Packaged native capture" } });
    fireEvent.click(screen.getByRole("button", { name: "Append report" }));
    expect(await screen.findByRole("heading", { name: "Renderer checked" })).toBeInTheDocument();
    expect(screen.getByText("Packaged native capture")).toBeInTheDocument();
    expect(api.updateGoalStatus).not.toHaveBeenCalled();
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it("closes only the active editor on Escape then allows parent close", async () => {
    const { controller } = nativeController(); const close = vi.fn();
    render(<WorkflowPanelView controller={controller} onClose={close} />);
    await screen.findByRole("button", { name: /ship evidence.*active/i });
    fireEvent.click(screen.getByRole("button", { name: "New goal" }));
    fireEvent.keyDown(screen.getByLabelText("Goal title"), { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Create goal" })).not.toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("region", { name: "Goals and evidence" }), { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
