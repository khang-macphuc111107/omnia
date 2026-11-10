import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AgentMeshSupervisorFlow,
  computeSupervisorFlowLayers,
  supervisorFlowStats,
  type SupervisorFlowTask,
} from "./agent-mesh-supervisor-flow";

const tasks: readonly SupervisorFlowTask[] = [
  { id: "task:root", title: "Root evidence", mode: "steer", state: "running", owner: "Researcher", dependencies: [] },
  { id: "task:middle", title: "Middle contract", mode: "queue", state: "ready", owner: "Builder", dependencies: ["task:root"] },
  { id: "task:leaf", title: "Leaf review", mode: "parallel", state: "blocked", owner: "Verifier", dependencies: ["task:middle"] },
  { id: "task:orphan", title: "Orphan claim", mode: "btw", state: "waiting", owner: "Reviewer", dependencies: ["task:missing"] },
];

describe("AgentMeshSupervisorFlow", () => {
  it("derives stable layers and ignores missing dependency ids", () => {
    expect(computeSupervisorFlowLayers(tasks)).toEqual([
      { depth: 0, taskIds: ["task:root", "task:orphan"] },
      { depth: 1, taskIds: ["task:middle"] },
      { depth: 2, taskIds: ["task:leaf"] },
    ]);
    expect(supervisorFlowStats(tasks)).toEqual({
      taskCount: 4,
      rootCount: 2,
      edgeCount: 3,
      attentionCount: 1,
      maxDepth: 2,
    });
  });

  it("renders dependency layers and a selected node detail", () => {
    render(<AgentMeshSupervisorFlow tasks={tasks} selectedTaskId="task:root" onSelectTask={() => undefined} />);

    expect(screen.getByRole("list", { name: "Supervisor dependency layers" })).toHaveTextContent("Layer 0");
    expect(screen.getByRole("button", { name: /Middle contract\. Ready preview/i })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Selected dependency node" })).toHaveTextContent("Downstream");
    expect(screen.getByRole("complementary", { name: "Selected dependency node" })).toHaveTextContent("Middle contract");
    expect(screen.getByText(/does not prove native readiness/i)).toBeInTheDocument();
  });

  it("emits the selected node without suggesting a native mutation", () => {
    const selected: string[] = [];
    render(<AgentMeshSupervisorFlow tasks={tasks} selectedTaskId="task:root" onSelectTask={(taskId) => selected.push(taskId)} />);

    fireEvent.click(screen.getByRole("button", { name: /Leaf review\. Blocked/i }));
    expect(selected).toEqual(["task:leaf"]);
    expect(within(screen.getByRole("complementary", { name: "Selected dependency node" })).getByRole("heading", { name: "Leaf review" })).toBeInTheDocument();
  });
});
