import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AlgorithmLabPreview from "./algorithm-lab-preview";

describe("AlgorithmLabPreview", () => {
  it("offers editable algorithm presets and deterministic binary-search output", () => {
    render(<AlgorithmLabPreview />);
    expect(screen.getByRole("heading", { name: /Algorithm & CP Lab/i })).toBeInTheDocument();
    expect(screen.getByText(/Found at index 3/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Two-sum hash map/i }));
    fireEvent.change(screen.getByLabelText("Algorithm numbers"), { target: { value: "2, 7, 11, 15" } });
    fireEvent.change(screen.getByLabelText("Algorithm target"), { target: { value: "9" } });
    expect(screen.getByText(/Pair at indices 0 \+ 1/i)).toBeInTheDocument();
  });

  it("rehearses merge sort with editable input and exposes the merge trace", () => {
    render(<AlgorithmLabPreview />);
    fireEvent.click(screen.getByRole("button", { name: /Merge sort/i }));
    fireEvent.change(screen.getByLabelText("Algorithm numbers"), { target: { value: "5, -1, 5, 2" } });

    expect(screen.getByText("-1, 2, 5, 5")).toBeInTheDocument();
    expect(screen.getByText(/stable ascending order/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Run preview/i }));
    expect(screen.getByRole("tabpanel", { name: "Trace" })).toHaveTextContent(/merge/i);
  });

  it("rehearses topological ordering and reports directed cycles", () => {
    render(<AlgorithmLabPreview />);
    fireEvent.click(screen.getByRole("button", { name: /Topological sort/i }));
    fireEvent.change(screen.getByLabelText("Directed graph edges"), { target: { value: "A → B, A → C, B → D, C → D" } });
    expect(screen.getByText("A → B → C → D")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Directed graph edges"), { target: { value: "A → B, B → A" } });
    expect(screen.getByText("Cycle detected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Run preview/i }));
    expect(screen.getByText(/never reached zero indegree/i)).toBeInTheDocument();
  });

  it("replays Union-Find operations with representatives and component counts", () => {
    render(<AlgorithmLabPreview />);
    fireEvent.click(screen.getByRole("button", { name: /Union-Find · DSU/i }));
    fireEvent.change(screen.getByLabelText("Union-Find operations"), {
      target: { value: "union(A,B); union(B,C); find(A); connected(A,C); components" },
    });

    expect(screen.getByText("A / B / C")).toBeInTheDocument();
    expect(screen.getByText("1 component(s) · 3 node(s) initialized")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Run preview/i }));
    expect(screen.getByRole("tabpanel", { name: "Trace" })).toHaveTextContent("Representative is A");
    expect(screen.getByRole("tabpanel", { name: "Trace" })).toHaveTextContent("Yes · representative A.");
  });

  it("builds a deterministic Kruskal minimum spanning tree and rejects cycle edges", () => {
    render(<AlgorithmLabPreview />);
    fireEvent.click(screen.getByRole("button", { name: /Kruskal · MST/i }));
    fireEvent.change(screen.getByLabelText("Graph edges"), { target: { value: "A-B:4, A-C:9, B-C:2, B-D:7, C-D:3" } });

    expect(screen.getByText("MST weight 9")).toBeInTheDocument();
    expect(screen.getByText(/4 nodes · 3 selected edge\(s\)/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Run preview/i }));
    const trace = screen.getByRole("tabpanel", { name: "Trace" });
    expect(trace).toHaveTextContent(/Accept B — C \(2\)/);
    expect(trace).toHaveTextContent(/Reject B — D \(7\)/);
    expect(trace).toHaveTextContent(/would create a cycle/i);
  });

  it("renders a graph trace and records a renderer-local rehearsal", () => {
    render(<AlgorithmLabPreview />);
    fireEvent.click(screen.getByRole("button", { name: /Dijkstra shortest path/i }));
    fireEvent.change(screen.getByLabelText("Graph edges"), { target: { value: "A-B:4, B-C:2, C-D:3" } });
    fireEvent.click(screen.getByRole("button", { name: /Run preview/i }));

    expect(screen.getByRole("tab", { name: "Trace" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: /A → B → C → D/i })).toBeInTheDocument();
    expect(screen.getByText(/Recent rehearsals/i)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Algorithm lab history" })).getByRole("button", { name: /Dijkstra shortest path/i })).toBeInTheDocument();
  });

  it("provides a complexity playground with accessible tab semantics", () => {
    render(<AlgorithmLabPreview />);
    const tabs = screen.getByRole("tablist", { name: "Algorithm lab views" });
    const playground = within(tabs).getByRole("tab", { name: "Playground" });
    const complexity = within(tabs).getByRole("tab", { name: "Complexity" });
    expect(playground).toHaveAttribute("aria-controls", "algorithm-lab-panel-playground");

    fireEvent.click(complexity);
    expect(screen.getByRole("tabpanel", { name: "Complexity" })).toHaveAttribute("aria-labelledby", complexity.id);
    fireEvent.change(screen.getByLabelText("Complexity input n"), { target: { value: "32" } });
    expect(screen.getByText("O(log n)")).toBeInTheDocument();
    expect(screen.getByText("32")).toBeInTheDocument();
  });

  it("offers language-selectable reference snippets with correctness notes", () => {
    render(<AlgorithmLabPreview />);
    fireEvent.click(screen.getByRole("tab", { name: "Pseudocode" }));

    expect(screen.getByRole("tabpanel", { name: "Pseudocode" })).toHaveTextContent(/If target exists/i);
    expect(screen.getByRole("code")).toHaveTextContent(/low ← 0/i);
    fireEvent.change(screen.getByLabelText("Algorithm pseudocode language"), { target: { value: "python" } });
    expect(screen.getByRole("code")).toHaveTextContent(/low = 0/i);
    expect(screen.getByRole("button", { name: "Copy snippet" })).toBeInTheDocument();
  });

  it("updates the reference snippet and edge-case checklist per algorithm", () => {
    render(<AlgorithmLabPreview />);
    fireEvent.click(screen.getByRole("button", { name: /Dijkstra shortest path/i }));
    fireEvent.click(screen.getByRole("tab", { name: "Pseudocode" }));
    fireEvent.change(screen.getByLabelText("Algorithm pseudocode language"), { target: { value: "cpp" } });

    expect(screen.getByRole("code")).toHaveTextContent(/priority_queue/i);
    expect(screen.getByText(/Negative edge rejected by this preview/i)).toBeInTheDocument();
    expect(screen.getByText(/Snippet is generated from the selected pattern/i)).toBeInTheDocument();
  });

  it("exports JSON and Markdown previews without claiming execution", () => {
    render(<AlgorithmLabPreview />);
    fireEvent.click(screen.getByRole("tab", { name: "Export" }));
    const panel = screen.getByRole("tabpanel", { name: "Export" });
    expect(within(panel).getByRole("code")).toHaveTextContent(/omnia\.algorithm-lab\.preview\.v1/);
    fireEvent.change(within(panel).getByLabelText(/format/i), { target: { value: "markdown" } });
    expect(within(panel).getByRole("code")).toHaveTextContent(/Renderer-local preview/);
    expect(within(panel).getByRole("code")).toHaveTextContent(/no code execution/i);
  });
});
