import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PLAN_APPROVED_MESSAGE, PlanCard } from "./plan-card";

describe("PlanCard", () => {
  it("approves into the chosen mode", () => {
    const onApprove = vi.fn();
    render(<PlanCard plan="1. Do it" onApprove={onApprove} onKeepPlanning={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Mode to switch to"), { target: { value: "auto" } });
    fireEvent.click(screen.getByRole("button", { name: /Approve & switch to/ }));
    expect(onApprove).toHaveBeenCalledWith("auto");
  });

  it("keeps planning with optional feedback", () => {
    const onKeep = vi.fn();
    render(<PlanCard plan="1. Do it" onApprove={vi.fn()} onKeepPlanning={onKeep} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep planning" }));
    expect(onKeep).toHaveBeenLastCalledWith("");
    fireEvent.change(screen.getByLabelText("Feedback for the plan"), { target: { value: "  add tests " } });
    fireEvent.click(screen.getByRole("button", { name: "Keep planning" }));
    expect(onKeep).toHaveBeenLastCalledWith("add tests");
  });

  it("has a default approval message", () => {
    expect(DEFAULT_PLAN_APPROVED_MESSAGE).toBe("Plan approved. Proceed.");
  });
});
