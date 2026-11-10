import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useState } from "react";

import { AutomationConditionSetPreview, createDefaultAutomationConditionSet, validateAutomationConditionSet } from "./automation-condition-set-preview";

function ConditionSetHarness() {
  const [snapshot, setSnapshot] = useState(() => createDefaultAutomationConditionSet(true));
  return <AutomationConditionSetPreview snapshot={snapshot} onChange={setSnapshot} onReset={() => setSnapshot(createDefaultAutomationConditionSet(true))} />;
}

describe("Automation condition set preview", () => {
  it("validates ALL and ANY rule expressions in the renderer", () => {
    expect(validateAutomationConditionSet({
      join: "all",
      rules: [
        { id: "a", field: "artifact.status", operator: "equals", value: "ready" },
        { id: "b", field: "artifact.score", operator: "greater-than", value: "0.8" },
      ],
    })).toMatchObject({ ready: true, expression: "artifact.status equals ready AND artifact.score is greater than 0.8" });
    expect(validateAutomationConditionSet({ join: "any", rules: [{ id: "a", field: "", operator: "equals", value: "" }] }).ready).toBe(false);
  });

  it("adds, edits, removes and previews a multi-rule guard set", () => {
    render(<ConditionSetHarness />);

    expect(screen.getByRole("region", { name: "Advanced condition rule set" })).toHaveTextContent(/1 rule.*all must match/i);
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Condition rule join" }), { target: { value: "any" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Condition rule 2 field" }), { target: { value: "message.priority" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Condition rule 2 operator" }), { target: { value: "equals" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Condition rule 2 value" }), { target: { value: "urgent" } });

    const region = screen.getByRole("region", { name: "Advanced condition rule set" });
    expect(region).toHaveTextContent(/2 rules.*any may match/i);
    expect(region).toHaveTextContent("artifact.status equals ready OR message.priority equals urgent");
    expect(within(region).getAllByText("Valid")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Preview rule JSON" }));
    expect(screen.getByRole("region", { name: "Advanced condition rule set" })).toHaveTextContent(/omnia\.automation-condition-set\.preview\.v1/);
    fireEvent.click(screen.getByRole("button", { name: "Remove condition rule 2" }));
    expect(screen.queryByRole("textbox", { name: "Condition rule 2 field" })).not.toBeInTheDocument();
  });

  it("reports incomplete and non-numeric rules without claiming execution", () => {
    render(<ConditionSetHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Condition rule 2 operator" }), { target: { value: "greater-than" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Condition rule 2 field" }), { target: { value: "artifact.score" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Condition rule 2 value" }), { target: { value: "high" } });
    expect(screen.getByText(/numeric comparisons need a number/i)).toBeInTheDocument();
    expect(screen.getByText(/no execution authority/i)).toBeInTheDocument();
  });
});
