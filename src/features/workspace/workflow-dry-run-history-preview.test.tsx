import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  serializeWorkflowDryRunHistory,
  WorkflowDryRunHistoryPreview,
  type WorkflowDryRunRecord,
} from "./workflow-dry-run-history-preview";

const run: WorkflowDryRunRecord = {
  id: "dry-run-test-1",
  workflowId: "workflow-test",
  workflowName: "Evidence review workflow",
  revision: 2,
  trigger: "manual",
  status: "simulated",
  occurredAt: "Today · 09:00",
  durationEstimate: "20s",
  costEstimate: "$0.00 preview",
  routeLabel: "Renderer route · not dispatched",
  summary: "Prepare a visible review checklist.",
  steps: [
    { id: "step-1", label: "Collect cards", detail: "Read visible cards only.", effect: "read", status: "would-run" },
    { id: "step-2", label: "Publish result", detail: "Requires a native receipt.", effect: "external", status: "blocked" },
  ],
  warnings: ["No provider call was made."],
};

describe("WorkflowDryRunHistoryPreview", () => {
  it("shows bounded dry-run history and truthful execution boundaries", () => {
    render(<WorkflowDryRunHistoryPreview runs={[run]} />);

    const region = screen.getByRole("region", { name: "Dry-run history" });
    expect(within(region).getByRole("heading", { name: "Dry-run history" })).toBeInTheDocument();
    expect(within(region).getByText(/no durable write.*no provider request/i)).toBeInTheDocument();
    expect(within(region).getAllByText("Evidence review workflow").length).toBeGreaterThan(0);
    expect(within(region).getAllByText(/Preview only/).length).toBeGreaterThan(0);
    expect(within(region).getByText("Publish result")).toBeInTheDocument();
    expect(within(region).getAllByText(/Blocked/).length).toBeGreaterThan(0);
  });

  it("filters records and rehearses a selected workflow locally", () => {
    const blockedRun: WorkflowDryRunRecord = { ...run, id: "dry-run-test-2", workflowName: "Blocked export", status: "blocked", trigger: "schedule" };
    render(<WorkflowDryRunHistoryPreview runs={[run, blockedRun]} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Dry-run status filter" }), { target: { value: "blocked" } });
    expect(within(screen.getByRole("list", { name: "Workflow dry-run records" })).getByText("Blocked export")).toBeInTheDocument();
    const historyList = screen.getByRole("list", { name: "Workflow dry-run records" });
    expect(within(historyList).queryByText("Evidence review workflow")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Blocked export/ }));
    fireEvent.click(screen.getByRole("button", { name: "Rehearse again locally" }));
    expect(screen.getByRole("status")).toHaveTextContent(/rehearsed again in renderer history/i);
    expect(screen.getByText("Total rehearsals").parentElement).toHaveTextContent("3");
  });

  it("filters by workflow and scopes the portable export", () => {
    const secondRun: WorkflowDryRunRecord = {
      ...run,
      id: "dry-run-test-2",
      workflowId: "other-workflow",
      workflowName: "Release notes workflow",
      status: "needs-review",
    };
    render(<WorkflowDryRunHistoryPreview runs={[run, secondRun]} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Dry-run workflow filter" }), { target: { value: "other-workflow" } });
    const historyList = screen.getByRole("list", { name: "Workflow dry-run records" });
    expect(within(historyList).getByText("Release notes workflow")).toBeInTheDocument();
    expect(within(historyList).queryByText("Evidence review workflow")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Dry-run history export scope" }), { target: { value: "filtered" } });
    expect(screen.getByText("1 run in this export")).toBeInTheDocument();
    const exportRegion = screen.getByRole("region", { name: "JSON dry-run history export preview" });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent("Release notes workflow");
    expect(within(exportRegion).getByRole("code")).not.toHaveTextContent("Evidence review workflow");
  });

  it("opens a JSON/Markdown export preview without claiming native export", () => {
    render(<WorkflowDryRunHistoryPreview runs={[run]} />);

    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    const exportRegion = screen.getByRole("region", { name: "JSON dry-run history export preview" });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/omnia\.workflow-dry-run-history\.preview\.v1/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/No provider request/);

    fireEvent.change(screen.getByRole("combobox", { name: "Dry-run history export format" }), { target: { value: "markdown" } });
    expect(screen.getByRole("region", { name: "Markdown dry-run history export preview" })).toHaveTextContent(/# Omnia workflow dry-run history preview/);
  });

  it("serializes Markdown and redacts sensitive diagnostic text", () => {
    const secretRun = { ...run, summary: "Bearer abcdefghijklmnop at C:\\Users\\Khang\\secret.txt" };
    const payload = serializeWorkflowDryRunHistory([secretRun], "markdown");

    expect(payload).toContain("# Omnia workflow dry-run history preview");
    expect(payload).toContain("Evidence review workflow");
    expect(payload).not.toContain("abcdefghijklmnop");
    expect(payload).not.toContain("C:\\Users\\Khang\\secret.txt");
  });

  it("reports clipboard failure without pretending an export was written", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<WorkflowDryRunHistoryPreview runs={[run]} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByText(/Clipboard access was denied/i)).toBeInTheDocument();
  });
});
