import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  buildWorkflowRunDiff,
  serializeWorkflowRunDiff,
  WorkflowRunDiffPreview,
} from "./workflow-run-diff-preview";
import type { WorkflowDryRunRecord } from "./workflow-dry-run-history-preview";

const baseline: WorkflowDryRunRecord = {
  id: "dry-run-baseline",
  workflowId: "digest",
  workflowName: "Research digest",
  revision: 1,
  trigger: "schedule",
  status: "simulated",
  occurredAt: "Today · 08:00",
  durationEstimate: "40s",
  costEstimate: "$0.00 preview",
  routeLabel: "Notebook synthesis · not dispatched",
  summary: "Summarize visible sources for review.",
  steps: [
    { id: "collect", label: "Collect sources", detail: "Use visible notebook sources.", effect: "read", status: "would-run" },
    { id: "publish", label: "Publish brief", detail: "Requires approval.", effect: "external", status: "blocked" },
  ],
  warnings: ["No provider request was made."],
};

const current: WorkflowDryRunRecord = {
  ...baseline,
  id: "dry-run-current",
  revision: 2,
  status: "needs-review",
  durationEstimate: "1m 10s",
  routeLabel: "Notebook synthesis + citation check · not dispatched",
  summary: "Summarize sources and check citation coverage before review.",
  steps: [
    { id: "collect", label: "Collect sources", detail: "Use visible notebook sources.", effect: "read", status: "would-run" },
    { id: "citations", label: "Check citations", detail: "Review visible anchors.", effect: "transform", status: "would-run" },
    { id: "publish", label: "Publish brief", detail: "Requires approval.", effect: "external", status: "blocked" },
  ],
  warnings: ["No provider request was made.", "Citation review needs a human check."],
};

describe("WorkflowRunDiffPreview", () => {
  it("builds typed field, step, warning, and approval deltas", () => {
    const diff = buildWorkflowRunDiff(baseline, current);

    expect(diff.summary.added).toBeGreaterThan(0);
    expect(diff.summary.changed).toBeGreaterThan(0);
    expect(diff.steps.find((step) => step.id === "citations")?.kind).toBe("added");
    expect(diff.warningsAdded).toContain("Citation review needs a human check.");
    expect(diff.approvalDelta).toBe("more-review");
  });

  it("serializes a redacted JSON and Markdown preview", () => {
    const diff = buildWorkflowRunDiff(
      { ...baseline, summary: "Bearer abcdefghijklmnop at C:\\Users\\khang\\secret.txt" },
      current,
    );
    const json = serializeWorkflowRunDiff(diff, "json");
    const markdown = serializeWorkflowRunDiff(diff, "markdown");

    expect(json).toContain("omnia.workflow-run-diff.preview.v1");
    expect(json).toContain("preview-only");
    expect(markdown).toContain("# Omnia workflow run diff preview");
    expect(json).not.toContain("abcdefghijklmnop");
    expect(json).not.toContain("C:\\Users\\khang\\secret.txt");
  });

  it("lets the user swap/filter runs and keeps export renderer-local", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<WorkflowRunDiffPreview runs={[baseline, current]} selectedRunId={current.id} />);

    expect(screen.getByRole("heading", { name: "Run diff" })).toBeInTheDocument();
    expect(screen.getByText(/No provider request, approval receipt/i)).toBeInTheDocument();
    expect(screen.getByText("Check citations")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Run diff filter" }), { target: { value: "added" } });
    expect(screen.getByText("Check citations")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Run metadata changes" })).queryByText("Route")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview run diff export" }));
    const exportRegion = screen.getByRole("region", { name: "JSON run diff export preview" });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/workflow-run-diff\.preview\.v1/);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByText(/JSON run diff copied/i)).toBeInTheDocument();
  });
});
