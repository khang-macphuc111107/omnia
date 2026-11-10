import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AgentOrchestrationPromptPreview, {
  deriveOrchestrationPlan,
  serializeOrchestrationPlan,
} from "./agent-orchestration-prompt-preview";

describe("AgentOrchestrationPromptPreview", () => {
  it("derives bounded roles from prompt signals without claiming execution", () => {
    const plan = deriveOrchestrationPlan("Research the latest compiler design, implement a small UI, and review the result.", "auto", "auto", 5);
    expect(plan.roles.find((role) => role.id === "researcher")?.enabled).toBe(true);
    expect(plan.roles.find((role) => role.id === "builder")?.enabled).toBe(true);
    expect(plan.roles.find((role) => role.id === "reviewer")?.enabled).toBe(true);
    expect(plan.maxAgents).toBe(5);
    expect(serializeOrchestrationPlan(plan)).toContain("preview-only");
    expect(serializeOrchestrationPlan(plan)).toContain("No model or provider request was made");
  });

  it("supports prompt analysis, role model overrides, and reversible edits", () => {
    render(<AgentOrchestrationPromptPreview />);

    const prompt = screen.getByRole("textbox", { name: "Orchestration task prompt" });
    fireEvent.change(prompt, { target: { value: "Research sources and build the feature." } });
    fireEvent.change(screen.getByRole("combobox", { name: "Orchestration strategy" }), { target: { value: "discuss" } });
    fireEvent.click(screen.getByRole("button", { name: /Preview plan/i }));

    expect(screen.getByText(/multi-perspective discussion staged/i)).toBeInTheDocument();
    const builderModel = screen.getByRole("combobox", { name: "Builder orchestration model" });
    fireEvent.change(builderModel, { target: { value: "frontier" } });
    expect(builderModel).toHaveValue("frontier");

    fireEvent.click(screen.getByRole("button", { name: "Undo orchestration plan change" }));
    expect(builderModel).toHaveValue("local-code");
    fireEvent.click(screen.getByRole("button", { name: "Redo orchestration plan change" }));
    expect(builderModel).toHaveValue("frontier");
    expect(screen.getByText(/no agent or provider was dispatched/i, { selector: "p" })).toBeInTheDocument();
  });

  it("allows context mode, agent cap, optional roles, and reset", () => {
    render(<AgentOrchestrationPromptPreview />);
    fireEvent.change(screen.getByRole("combobox", { name: "Orchestration context mode" }), { target: { value: "partial" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Maximum orchestration agents" }), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: /Preview plan/i }));
    expect(screen.getByText("partial")).toBeInTheDocument();
    expect(screen.getByText("6", { selector: ".agent-orchestration-prompt__summary strong" })).toBeInTheDocument();

    expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Reset/i }));
    expect(screen.getByRole("combobox", { name: "Orchestration context mode" })).toHaveValue("auto");
    expect(screen.getByText(/plan reset/i)).toBeInTheDocument();
  });

  it("fails closed when clipboard access is unavailable", async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");
    Object.defineProperty(Navigator.prototype, "clipboard", { configurable: true, value: undefined });

    try {
      render(<AgentOrchestrationPromptPreview />);
      fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));

      expect(screen.getByText(/Clipboard unavailable/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(Navigator.prototype, "clipboard", clipboardDescriptor);
      } else {
        delete (Navigator.prototype as { clipboard?: unknown }).clipboard;
      }
    }
  });
});
