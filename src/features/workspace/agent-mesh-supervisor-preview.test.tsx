import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentMeshSupervisorPreview } from "./agent-mesh-supervisor-preview";

describe("AgentMeshSupervisorPreview", () => {
  it("renders queue projections with explicit renderer-only boundaries", () => {
    render(<AgentMeshSupervisorPreview linkedWorkCount={2} />);

    expect(screen.getByRole("heading", { name: "Agent Mesh supervisor" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Supervisor task queue" })).toHaveTextContent("Compile context availability evidence");
    expect(screen.getByRole("region", { name: "Agent mesh supervisor preview" })).toHaveTextContent("2 background items");
    expect(screen.getByRole("region", { name: "Agent mesh supervisor preview" })).toHaveTextContent("does not spawn or reassign agents");
  });

  it("shows bounded task detail and keeps rehearsal actions non-mutating", () => {
    render(<AgentMeshSupervisorPreview />);

    const queue = screen.getByRole("list", { name: "Supervisor task queue" });
    fireEvent.click(within(queue).getByRole("listitem", { name: /Apply renderer UI contract slice\. Blocked/i }));
    const detail = screen.getByRole("complementary", { name: "Selected supervisor task" });
    expect(detail).toHaveTextContent("Blocked until its source evidence dependency is completed");
    expect(detail).toHaveTextContent("write:src/features/workspace");

    fireEvent.click(within(detail).getByRole("button", { name: /Preview reassignment/i }));
    expect(screen.getByRole("status")).toHaveTextContent("no native scheduler, lease or task mutation");
  });

  it("exposes policy and signal tabs with truthful target-contract wording", () => {
    render(<AgentMeshSupervisorPreview />);

    fireEvent.click(screen.getByRole("tab", { name: "Policies" }));
    expect(screen.getByRole("tabpanel", { name: "Policies" })).toHaveTextContent("Subset of parent");
    expect(screen.getByRole("tabpanel", { name: "Policies" })).toHaveTextContent("do not grant renderer authority");

    fireEvent.click(screen.getByRole("tab", { name: "Signals" }));
    expect(screen.getByRole("tabpanel", { name: "Signals" })).toHaveTextContent("Readiness");
    expect(screen.getByRole("tabpanel", { name: "Signals" })).toHaveTextContent("No supervisor event cursor");
  });

  it("supports roving keyboard navigation across supervisor tabs", () => {
    render(<AgentMeshSupervisorPreview />);

    const queueTab = screen.getByRole("tab", { name: "Queue" });
    const policyTab = screen.getByRole("tab", { name: "Policies" });
    expect(queueTab).toHaveAttribute("aria-controls", "agent-mesh-supervisor-panel-queue");
    expect(policyTab).toHaveAttribute("tabindex", "-1");

    queueTab.focus();
    fireEvent.keyDown(queueTab, { key: "ArrowRight" });
    expect(policyTab).toHaveFocus();
    expect(policyTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Policies" })).toHaveAttribute("aria-labelledby", policyTab.id);
  });

  it("supports reversible policy rehearsal without native mutation", () => {
    render(<AgentMeshSupervisorPreview />);
    fireEvent.click(screen.getByRole("tab", { name: "Policies" }));

    const childAuthority = screen.getByRole("combobox", { name: "Supervisor policy Child authority" });
    fireEvent.change(childAuthority, { target: { value: "review-each-expansion" } });
    expect(childAuthority).toHaveValue("review-each-expansion");
    expect(screen.getByText("1 changes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo supervisor policy preview change" }));
    expect(childAuthority).toHaveValue("subset-only");
    fireEvent.click(screen.getByRole("button", { name: "Redo supervisor policy preview change" }));
    expect(childAuthority).toHaveValue("review-each-expansion");

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(childAuthority).toHaveValue("subset-only");
    expect(screen.getByRole("status")).toHaveTextContent(/no supervisor authority changed/i);
  });
});
