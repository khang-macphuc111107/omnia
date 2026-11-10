import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AgentMeshReconciliationPreview, {
  RECONCILIATION_CONFLICTS,
  reconciliationConflictMatches,
  serializeReconciliationPreview,
} from "./agent-mesh-reconciliation-preview";

describe("AgentMeshReconciliationPreview", () => {
  it("renders bounded conflict inventory and selected contender detail", () => {
    render(<AgentMeshReconciliationPreview linkedWorkCount={3} />);

    const region = screen.getByRole("region", { name: "Agent mesh reconciliation preview" });
    expect(within(region).getByRole("heading", { name: "Reconciliation Studio", level: 2 })).toBeInTheDocument();
    expect(within(region).getByText("4")).toBeInTheDocument();
    expect(within(region).getByText("3")).toBeInTheDocument();
    expect(within(region).getByRole("heading", { name: "docs/omnia-ultra/evidence/source-ledger.json", level: 3 })).toBeInTheDocument();
    expect(within(region).getByText(/No file read\/write, branch merge/i)).toBeInTheDocument();
  });

  it("keeps strategy and state changes inside the renderer preview", () => {
    render(<AgentMeshReconciliationPreview />);
    const region = screen.getByRole("region", { name: "Agent mesh reconciliation preview" });

    const holdAction = within(region).getAllByRole("button", { name: "Hold write" }).at(-1);
    expect(holdAction).toBeDefined();
    fireEvent.click(holdAction!);
    expect(within(region).getAllByText("Held in preview").at(-1)).toBeInTheDocument();
    const strategyGroup = within(region).getByRole("group", { name: "Reconciliation strategy" });
    fireEvent.click(within(strategyGroup).getByRole("button", { name: "Manual review" }));
    expect(within(strategyGroup).getByRole("button", { name: "Manual review" })).toHaveAttribute("aria-pressed", "true");
    expect(within(region).getByRole("status")).toHaveTextContent(/Manual review selected/i);

    fireEvent.click(within(region).getByRole("button", { name: "Mark resolved in preview" }));
    expect(within(region).getAllByText("Resolved in preview").at(-1)).toBeInTheDocument();
  });

  it("supports plan and evidence tabs with keyboard-friendly tab semantics", () => {
    render(<AgentMeshReconciliationPreview />);
    const region = screen.getByRole("region", { name: "Agent mesh reconciliation preview" });
    const conflictsTab = within(region).getByRole("tab", { name: "Conflicts" });
    const planTab = within(region).getByRole("tab", { name: "Plan" });
    const evidenceTab = within(region).getByRole("tab", { name: "Evidence" });

    expect(conflictsTab).toHaveAttribute("aria-selected", "true");
    fireEvent.click(planTab);
    expect(planTab).toHaveAttribute("aria-selected", "true");
    expect(within(region).getByRole("tabpanel", { name: "Plan" })).toHaveTextContent(/Preview step/i);
    fireEvent.click(evidenceTab);
    expect(evidenceTab).toHaveAttribute("aria-selected", "true");
    expect(within(region).getByRole("tabpanel", { name: "Evidence" })).toHaveTextContent(/Evidence register/i);
  });

  it("serializes JSON and Markdown with explicit preview boundaries", () => {
    const json = serializeReconciliationPreview(RECONCILIATION_CONFLICTS, {}, {}, "json");
    expect(json).toContain("omnia.agent-mesh-reconciliation-preview.v1");
    expect(json).toContain('"durableWrite": false');
    expect(json).toContain('"strategy": "sequence"');

    const markdown = serializeReconciliationPreview(RECONCILIATION_CONFLICTS, {}, {}, "markdown");
    expect(markdown).toContain("# Omnia agent mesh reconciliation preview");
    expect(markdown).toContain("No file, branch, lease, mailbox, or scheduler mutation occurred");
    expect(markdown).toContain("## conflict:project-twin");
  });

  it("previews export controls without claiming a native receipt", () => {
    render(<AgentMeshReconciliationPreview />);
    const region = screen.getByRole("region", { name: "Agent mesh reconciliation preview" });
    fireEvent.click(within(region).getByRole("button", { name: "Export" }));
    expect(within(region).getByRole("region", { name: "JSON reconciliation export preview" })).toHaveTextContent("omnia.agent-mesh-reconciliation-preview.v1");
    fireEvent.change(within(region).getByRole("combobox", { name: "Reconciliation export format" }), { target: { value: "markdown" } });
    expect(within(region).getByRole("region", { name: "Markdown reconciliation export preview" })).toHaveTextContent("# Omnia agent mesh reconciliation preview");
    expect(within(region).getByText(/no durable write/i)).toBeInTheDocument();
  });

  it("searches conflict evidence and keeps the selected detail inside the visible set", () => {
    render(<AgentMeshReconciliationPreview />);
    const region = screen.getByRole("region", { name: "Agent mesh reconciliation preview" });
    const search = within(region).getByRole("textbox", { name: "Search reconciliation conflicts" });
    fireEvent.change(search, { target: { value: "project twin" } });

    const list = within(region).getByRole("listbox", { name: "Reconciliation conflicts" });
    expect(list).toHaveTextContent("docs/project-twin/manifest.json");
    expect(list).not.toHaveTextContent("source-ledger.json");
    expect(within(region).getByRole("heading", { name: "docs/project-twin/manifest.json", level: 3 })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "no such conflict" } });
    expect(list).toHaveTextContent("No conflicts match this filter.");
    expect(within(region).queryByRole("heading", { name: "docs/project-twin/manifest.json", level: 3 })).not.toBeInTheDocument();
  });

  it("supports bulk preview state changes without creating a native receipt", () => {
    render(<AgentMeshReconciliationPreview />);
    const region = screen.getByRole("region", { name: "Agent mesh reconciliation preview" });
    const list = within(region).getByRole("listbox", { name: "Reconciliation conflicts" });

    fireEvent.click(within(region).getByRole("button", { name: "Hold visible" }));
    expect(within(list).getAllByText(/Held in preview/)).toHaveLength(RECONCILIATION_CONFLICTS.length);
    expect(within(region).getByRole("status")).toHaveTextContent(/applied to 4 visible conflicts/i);

    fireEvent.click(within(region).getByRole("button", { name: "Reset visible" }));
    expect(within(list).queryByText(/Held in preview/)).not.toBeInTheDocument();
    expect(within(list).getAllByText(/Open/)).toHaveLength(RECONCILIATION_CONFLICTS.length);
  });

  it("matches search terms across conflict resources, contenders and evidence", () => {
    const conflict = RECONCILIATION_CONFLICTS.find((item) => item.id === "conflict:source-ledger");
    expect(conflict).toBeDefined();
    expect(reconciliationConflictMatches(conflict!, "open", "all", "status writer")).toBe(true);
    expect(reconciliationConflictMatches(conflict!, "open", "all", "source-ledger.json")).toBe(true);
    expect(reconciliationConflictMatches(conflict!, "open", "all", "missing token")).toBe(false);
    expect(reconciliationConflictMatches(conflict!, "held", "open", "status writer")).toBe(false);
  });
});
