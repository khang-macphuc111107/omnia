import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AutomationWorkflowPlanPreview, buildAutomationPlanGraph, buildAutomationWorkflowPlan, serializeAutomationWorkflowPlan } from "./automation-workflow-plan-preview";

const props = {
  automationName: "Morning research digest",
  scopeLabel: "Personal workspace",
  actionLabel: "Synthesize notebook",
  connectorLabel: "No external connector",
  approvalRoute: "review-changes" as const,
};

describe("Automation workflow plan preview", () => {
  it("builds a typed plan and exports JSON/Markdown with a preview boundary", () => {
    const plan = buildAutomationWorkflowPlan(props);
    expect(plan.steps).toHaveLength(6);
    expect(plan.preset).toBe("balanced");
    expect(plan.condition.operator).toBe("exists");
    expect(plan.steps[1]?.dependsOn).toEqual(["trigger"]);
    expect(buildAutomationPlanGraph(plan.steps)).toMatchObject({
      cycleDetected: false,
      topologicalOrder: ["trigger", "context", "condition", "action", "approval", "notify"],
      criticalPath: ["trigger", "context", "condition", "action", "approval", "notify"],
    });
    expect(serializeAutomationWorkflowPlan(plan, "json")).toContain("omnia.automation-workflow-plan.preview.v1");
    expect(serializeAutomationWorkflowPlan(plan, "json")).toContain('"graphSummary"');
    expect(serializeAutomationWorkflowPlan(plan, "markdown")).toContain("# Omnia automation workflow plan preview");
    expect(serializeAutomationWorkflowPlan(plan, "markdown")).toContain("no scheduler");
  });

  it("edits, reorders, toggles, and adds local checkpoints", () => {
    render(<AutomationWorkflowPlanPreview {...props} />);

    expect(screen.getByRole("heading", { name: "Plan steps & guardrails" })).toBeInTheDocument();
    expect(screen.getByText(/no scheduler, connector grant/i)).toBeInTheDocument();
    const contextRow = screen.getAllByRole("listitem")[1]!;
    fireEvent.click(within(contextRow).getByRole("button", { name: /^2 Prepare visible context/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Workflow step label" }), { target: { value: "Prepare project context" } });
    expect(screen.getByRole("button", { name: /^2 Prepare project context/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move step up" }));
    fireEvent.click(within(contextRow).getByRole("button", { name: "Disable Prepare project context" }));
    expect(within(contextRow).getByRole("button", { name: "Enable Prepare project context" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add checkpoint" }));
    expect(screen.getByRole("button", { name: /^7 Custom checkpoint/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Workflow DAG validation" })).toHaveTextContent(/Critical path/i);
  });

  it("exposes editable DAG edges and catches a local cycle before rehearsal", () => {
    render(<AutomationWorkflowPlanPreview {...props} />);

    const triggerRow = screen.getAllByRole("listitem")[0]!;
    fireEvent.click(within(triggerRow).getByRole("button", { name: /^1 Receive trigger/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Prepare visible context" }));
    expect(screen.getByRole("region", { name: "Workflow DAG validation" })).toHaveTextContent(/Needs review/i);
    fireEvent.click(screen.getByRole("button", { name: "Rehearse plan" }));
    expect(screen.getByText(/rehearsal paused/i)).toBeInTheDocument();
  });

  it("reports malformed draft edges without turning them into execution authority", () => {
    const plan = buildAutomationWorkflowPlan(props);
    const malformed = plan.steps.map((step) => ({ ...step, dependsOn: [...step.dependsOn] }));
    malformed[0] = { ...malformed[0]!, dependsOn: ["missing-step", "trigger"] };
    const graph = buildAutomationPlanGraph(malformed);
    expect(graph.unknownDependencyCount).toBe(1);
    expect(graph.selfDependencyCount).toBe(1);
    expect(graph.cycleDetected).toBe(true);
    expect(graph.topologicalOrder.length).toBeLessThan(malformed.length);
  });

  it("keeps draft edits undoable and redoable inside the renderer session", () => {
    render(<AutomationWorkflowPlanPreview {...props} />);

    const contextRow = screen.getAllByRole("listitem")[1]!;
    fireEvent.click(within(contextRow).getByRole("button", { name: /^2 Prepare visible context/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Workflow step label" }), { target: { value: "Context snapshot" } });
    expect(screen.getByRole("button", { name: /^2 Context snapshot/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo plan edit" }));
    expect(screen.getByRole("button", { name: /^2 Prepare visible context/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Redo plan edit" }));
    expect(screen.getByRole("button", { name: /^2 Context snapshot/ })).toBeInTheDocument();
  });

  it("keeps condition and approval rehearsal local and exposes export controls", async () => {
    render(<AutomationWorkflowPlanPreview {...props} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Workflow condition field" }), { target: { value: "artifact.status" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Workflow condition operator" }), { target: { value: "equals" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Workflow condition value" }), { target: { value: "ready" } });
    expect(screen.getByText("Condition ready")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Workflow approval route" }), { target: { value: "always-ask" } });
    expect(screen.getAllByText("Always ask").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Rehearse plan" }));
    expect(screen.getByText(/no endpoint called/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    const region = screen.getByRole("region", { name: "Workflow plan export" });
    expect(within(region).getByText(/omnia\.automation-workflow-plan\.preview\.v1/i)).toBeInTheDocument();
    fireEvent.change(within(region).getByRole("combobox", { name: "Workflow plan export format" }), { target: { value: "markdown" } });
    expect(within(region).getByText(/Omnia automation workflow plan preview/i)).toBeInTheDocument();
  });

  it("switches between bounded plan presets and exports the selected preset", () => {
    render(<AutomationWorkflowPlanPreview {...props} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Workflow plan preset" }), { target: { value: "ci-gate" } });
    expect(screen.getByText("Condition ready")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Workflow approval route" })).toHaveValue("always-ask");
    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    expect(screen.getByRole("region", { name: "Workflow plan export" })).toHaveTextContent(/ci-gate/);

    fireEvent.change(screen.getByRole("combobox", { name: "Workflow plan preset" }), { target: { value: "lean" } });
    expect(screen.getByText(/3\/3 enabled/)).toBeInTheDocument();
    expect(screen.getByText(/Lean path loaded/i)).toBeInTheDocument();
  });
});
