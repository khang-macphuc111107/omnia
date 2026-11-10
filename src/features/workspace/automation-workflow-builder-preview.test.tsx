import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { buildAutomationWorkflowPlan } from "./automation-workflow-plan-preview";
import { AutomationWorkflowBuilderPreview, serializeAutomationWorkflowBuilder, type AutomationBuilderStepDraft } from "./automation-workflow-builder-preview";

const props = {
  automationName: "Morning research digest",
  scopeLabel: "Workspace",
  actionLabel: "Synthesize brief",
  connectorLabel: "No connector",
  approvalRoute: "review-changes" as const,
};

describe("Automation workflow builder preview", () => {
  it("shows reusable templates and a bounded renderer boundary", () => {
    const plan = buildAutomationWorkflowPlan(props);
    render(<AutomationWorkflowBuilderPreview automationName={props.automationName} steps={plan.steps} />);

    expect(screen.getByRole("heading", { name: "Workflow builder palette" })).toBeInTheDocument();
    expect(screen.getByText(/Renderer-local builder · 6 plan steps/i)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Workflow builder templates" })).toHaveTextContent("Research review");
    expect(screen.getByRole("list", { name: "Workflow builder templates" })).toHaveTextContent("CI artifact handoff");
    expect(screen.getByText(/Choose a template to stage reusable steps/i)).toBeInTheDocument();
  });

  it("filters templates and stages resolved steps through the callback", () => {
    const plan = buildAutomationWorkflowPlan(props);
    const onAddSteps = vi.fn<(drafts: readonly AutomationBuilderStepDraft[]) => void>();
    render(<AutomationWorkflowBuilderPreview automationName={props.automationName} steps={plan.steps} onAddSteps={onAddSteps} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search builder templates" }), { target: { value: "ci" } });
    const templates = screen.getByRole("list", { name: "Workflow builder templates" });
    expect(within(templates).getByText("CI artifact handoff")).toBeInTheDocument();
    expect(within(templates).queryByText("Research review")).not.toBeInTheDocument();

    fireEvent.click(within(templates).getByRole("button", { name: /CI artifact handoff/i }));
    fireEvent.click(screen.getByRole("button", { name: "Stage template" }));

    expect(onAddSteps).toHaveBeenCalledTimes(1);
    expect(onAddSteps.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Check artifact status", kind: "condition" }),
      expect.objectContaining({ label: "Prepare release handoff", kind: "action" }),
    ]));
  });

  it("binds variables and resolves them in staged labels/details", () => {
    const plan = buildAutomationWorkflowPlan(props);
    const onAddSteps = vi.fn<(drafts: readonly AutomationBuilderStepDraft[]) => void>();
    render(<AutomationWorkflowBuilderPreview automationName={props.automationName} steps={plan.steps} onAddSteps={onAddSteps} />);

    fireEvent.click(screen.getByRole("button", { name: "Bind variables" }));
    const variables = screen.getByRole("region", { name: "Workflow builder variables" });
    const ownerValue = within(variables).getByRole("textbox", { name: "Variable value owner" });
    fireEvent.change(ownerValue, { target: { value: "Mạc Phúc Khang" } });
    fireEvent.click(screen.getByRole("button", { name: "Stage template" }));

    const staged = onAddSteps.mock.calls[0]?.[0] ?? [];
    expect(staged.some((step) => step.detail.includes("Mạc Phúc Khang"))).toBe(true);
    expect(staged.some((step) => step.detail.includes("{{owner}}"))).toBe(false);
  });

  it("stages a custom checkpoint and reports missing names", () => {
    const plan = buildAutomationWorkflowPlan(props);
    const onAddSteps = vi.fn<(drafts: readonly AutomationBuilderStepDraft[]) => void>();
    render(<AutomationWorkflowBuilderPreview automationName={props.automationName} steps={plan.steps} onAddSteps={onAddSteps} />);

    fireEvent.click(screen.getByRole("button", { name: "Stage checkpoint" }));
    expect(onAddSteps).not.toHaveBeenCalled();
    expect(screen.getByText(/Name the custom checkpoint/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Custom checkpoint name" }), { target: { value: "Freshness gate" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Custom checkpoint detail" }), { target: { value: "Confirm {{workspace}} is refreshed" } });
    fireEvent.click(screen.getByRole("button", { name: "Stage checkpoint" }));
    expect(onAddSteps).toHaveBeenCalledWith([{ kind: "condition", label: "Freshness gate", detail: "Confirm Current workspace is refreshed" }]);
  });

  it("exports template metadata and keeps the native boundary explicit", () => {
    const plan = buildAutomationWorkflowPlan(props);
    const template = {
      id: "research-review" as const,
      name: "Research review",
      category: "Research" as const,
      description: "Collect context",
      tone: "blue" as const,
      steps: [{ kind: "context" as const, label: "Collect {{workspace}}", detail: "For {{owner}}" }],
    };
    const payload = serializeAutomationWorkflowBuilder(props.automationName, template, [{ id: "owner", key: "owner", value: "Current user", enabled: true }]);
    expect(payload).toContain("omnia.automation-workflow-builder.preview.v1");
    expect(payload).toContain("No durable workflow write");
    expect(payload).toContain("Current user");

    render(<AutomationWorkflowBuilderPreview automationName={props.automationName} steps={plan.steps} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview JSON" }));
    expect(screen.getByRole("region", { name: "Workflow builder export" })).toHaveTextContent(/omnia\.automation-workflow-builder\.preview\.v1/i);
  });
});
