import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GoalOrchestrationRail } from "./goal-orchestration-rail";

describe("GoalOrchestrationRail", () => {
  it("moves a selected queue item to a distinct active preview slot and can return it", () => {
    render(<GoalOrchestrationRail goal="Shape the Omnia UI" />);
    fireEvent.change(screen.getByLabelText("Goal orchestration prompt"), { target: { value: "Make settings compact" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Make settings compact/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Steer selected" }));
    expect(screen.getByText("0/0")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Queued goal prompts" })).queryByRole("button", { name: /Make settings compact/i })).not.toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Active preview slot" })).getByText("Make settings compact")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Return to queue" }));
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Queued goal prompts" })).getByRole("button", { name: /Make settings compact/i })).toBeInTheDocument();
  });

  it("keeps prior active work at the front of the queue when a new prompt steers", () => {
    render(<GoalOrchestrationRail goal="Omnia" />);
    const prompt = screen.getByLabelText("Goal orchestration prompt");
    fireEvent.change(prompt, { target: { value: "first active" } });
    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    fireEvent.change(prompt, { target: { value: "ordinary queued" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    fireEvent.change(prompt, { target: { value: "next active" } });
    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    const queue = screen.getByRole("group", { name: "Queued goal prompts" });
    expect(within(queue).getAllByRole("button").map((item) => item.textContent)).toEqual([
      expect.stringContaining("first active"),
      expect.stringContaining("ordinary queued"),
    ]);
    expect(within(screen.getByRole("group", { name: "Active preview slot" })).getByText("next active")).toBeInTheDocument();
  });

  it("keeps Btw and Discuss outside the queue until explicitly promoted", () => {
    render(<GoalOrchestrationRail goal="Omnia" />);
    const prompt = screen.getByLabelText("Goal orchestration prompt");
    fireEvent.change(prompt, { target: { value: "side question" } });
    fireEvent.click(screen.getByRole("button", { name: "Btw" }));
    fireEvent.change(prompt, { target: { value: "team discussion" } });
    fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
    expect(screen.getByText("0/0")).toBeInTheDocument();
    expect(screen.getByText("Side notes · 2")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Queued goal prompts" })).queryByRole("button")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Promote side question into the preview queue"));
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(screen.getByText("Side notes · 1")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Queued goal prompts" })).getByRole("button", { name: /side question/i })).toBeInTheDocument();
  });

  it("reorders and removes without mutating native goals", () => {
    render(<GoalOrchestrationRail goal="Omnia" />);
    for (const title of ["first", "second"]) {
      fireEvent.change(screen.getByLabelText("Goal orchestration prompt"), { target: { value: title } });
      fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Move selected goal prompt up" }));
    expect(screen.getByRole("status")).toHaveTextContent("Queue order changed");
    fireEvent.click(screen.getByRole("button", { name: "Remove selected goal prompt" }));
    expect(screen.queryByRole("button", { name: /second/i })).not.toBeInTheDocument();
    expect(screen.getByText(/UI preview only: no model, agent, scheduler/i)).toBeInTheDocument();
  });
});
