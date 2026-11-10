import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AgentDagOrchestrationPreview, {
  buildAgentDagModel,
  serializeAgentDagPreview,
  type AgentDagNode,
} from "./agent-dag-orchestration-preview";

const nodes: readonly AgentDagNode[] = [
  { id: "root", label: "Root", role: "Planner", owner: "Core", state: "completed", dependencies: [] },
  { id: "left", label: "Left branch", role: "Researcher", owner: "Research", state: "ready", dependencies: ["root"] },
  { id: "right", label: "Right branch", role: "Builder", owner: "Build", state: "running", dependencies: ["root"] },
  { id: "join", label: "Join", role: "Reviewer", owner: "Quality", state: "blocked", dependencies: ["left", "right"] },
];

describe("AgentDagOrchestrationPreview", () => {
  it("derives layers, ready gates, leaves, and critical path from visible nodes", () => {
    const model = buildAgentDagModel(nodes);
    expect(model.layers).toEqual([
      { depth: 0, nodeIds: ["root"] },
      { depth: 1, nodeIds: ["left", "right"] },
      { depth: 2, nodeIds: ["join"] },
    ]);
    expect(model.roots).toEqual(["root"]);
    expect(model.leaves).toEqual(["join"]);
    expect(model.readyIds).toEqual(["left"]);
    expect(model.criticalPath).toEqual(["root", "left", "join"]);
    expect(model.cycleNodeIds).toEqual([]);
  });

  it("diagnoses malformed references without claiming to repair the graph", () => {
    const model = buildAgentDagModel([
      { id: "a", label: "A", role: "one", owner: "x", state: "ready", dependencies: ["missing", "a", "missing"] },
      { id: "b", label: "B", role: "two", owner: "y", state: "ready", dependencies: ["b"] },
    ]);
    expect(model.unknownDependencyCount).toBe(2);
    expect(model.selfDependencyCount).toBe(2);
    expect(model.duplicateDependencyCount).toBe(0);
    expect(model.cycleNodeIds).toEqual([]);
    expect(model.roots).toEqual(["a", "b"]);
  });

  it("reports cycles and duplicate references as diagnostics", () => {
    const model = buildAgentDagModel([
      { id: "a", label: "A", role: "one", owner: "x", state: "ready", dependencies: ["b", "b"] },
      { id: "b", label: "B", role: "two", owner: "y", state: "ready", dependencies: ["a"] },
      { id: "b", label: "B duplicate", role: "two", owner: "y", state: "ready", dependencies: [] },
    ]);
    expect(model.duplicateNodeIdCount).toBe(1);
    expect(model.duplicateDependencyCount).toBe(1);
    expect(model.cycleNodeIds).toEqual(["a", "b"]);
    expect(model.topologicalOrder).toEqual(["a", "b"]);
  });

  it("serializes a truthful renderer-only export contract", () => {
    const json = serializeAgentDagPreview(buildAgentDagModel(nodes));
    expect(json).toContain("omnia.agent-dag-orchestration.preview.v1");
    expect(json).toContain("preview-only");
    expect(json).toContain("No native agent spawn or scheduler call");
  });

  it("renders a selected node and keeps rehearsals non-mutating", () => {
    render(<AgentDagOrchestrationPreview nodes={nodes} />);

    expect(screen.getByRole("heading", { name: "Coordinate parallel agents with visible gates" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Agent DAG layers" })).toHaveTextContent("Layer 1");
    expect(screen.getByRole("button", { name: "Left branch. Ready" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Join. Blocked" }));
    const detail = screen.getByRole("complementary", { name: "Selected agent DAG node" });
    expect(detail).toHaveTextContent("Prerequisites");
    expect(detail).toHaveTextContent("Left branch, Right branch");

    fireEvent.click(within(detail).getByRole("button", { name: "Preview pause" }));
    expect(screen.getByRole("status")).toHaveTextContent("agent state is unchanged");
  });

  it("supports local visibility and critical-path controls", () => {
    render(<AgentDagOrchestrationPreview nodes={nodes} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show completed" }));
    expect(screen.queryByRole("button", { name: "Root. Completed" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Focus critical path" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset DAG view" }));
    expect(screen.getByRole("button", { name: "Root. Completed" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("no agent state or queue was changed");
  });
});
