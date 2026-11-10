import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ContextCompilerPreview, {
  buildContextCompilerReference,
  captureContextCompilerBaseline,
  compareContextCompilerBaseline,
} from "./context-compiler-preview";

const baseProps = {
  projectId: "project-omnia",
  projectName: "Omnia",
  instructions: "Prefer explicit evidence and keep source data untrusted.",
  folders: [{ id: "folder-1", displayName: "omnia", canonicalPath: "C:\\workspace\\omnia", state: "ready", scope: "read-only" }],
  memories: [{ id: "memory-1", label: "Coding preference", content: "Prefer small, reviewable patches.", confidence: 0.9 }],
  skills: [{ id: "skill-1", name: "Code review", description: "Review changes with evidence.", version: "1.0.0", tokenFootprint: 120 }],
  conversations: [],
  includeMemories: true,
  includeSkills: true,
  budgetTokens: 3200,
};

describe("ContextCompilerPreview", () => {
  it("builds a deterministic reference decision ledger with a final current request", () => {
    const first = buildContextCompilerReference(baseProps);
    const second = buildContextCompilerReference(baseProps);

    expect(first.error).toBeNull();
    expect(first.compiled?.referenceOnly).toBe(true);
    expect(first.compiled?.snapshot.selectedItemIds).toEqual(second.compiled?.snapshot.selectedItemIds);
    expect(first.compiled?.providerMessages.at(-1)?.contextItemIds.at(-1)).toBe("turn:omnia:current-request");
    expect(first.compiled?.previewItems.some((item) => item.selected)).toBe(true);
  });

  it("withholds aggregate compiler output when project context is over budget", () => {
    const result = buildContextCompilerReference({ ...baseProps, contextHealth: "over-budget" });

    expect(result.compiled).toBeNull();
    expect(result.status).toBe("withheld");
    expect(result.error).toBeNull();
    expect(result.withholdingReason).toMatch(/over the renderer preview budget/i);
  });

  it("preserves draft bytes, honors the requested input budget, and omits local paths from export-shaped evidence", () => {
    const exactDraft = "\n  Keep this draft indentation exactly.  \n";
    const result = buildContextCompilerReference({
      ...baseProps,
      budgetTokens: 800,
      conversations: [{
        id: "conversation-1",
        activeBranchId: "branch-1",
        title: "Omnia",
        excerpt: exactDraft,
        updatedAt: "2026-09-18T23:59:00.000Z",
        updatedLabel: "just now",
        projectId: baseProps.projectId,
        projectName: baseProps.projectName,
        pinned: false,
        archived: false,
        hasDraft: true,
        unread: false,
        runState: null,
        draft: exactDraft,
        messages: [{
          id: "message-1",
          role: "user",
          content: "  Historical bytes stay intact.  ",
          createdAt: "2026-09-18T23:58:00.000Z",
          status: "complete",
          modelLabel: null,
          runId: null,
          attachments: [],
          branchIndex: 0,
          branchCount: 1,
        }],
      }],
    });

    expect(result.error).toBeNull();
    expect(result.compiled?.snapshot.budget.availableInputTokens).toBe(800);
    expect(result.compiled?.providerMessages.at(-1)?.content).toBe(exactDraft);
    expect(result.compiled?.providerMessages.every((message) => !message.content.includes(baseProps.folders[0]!.canonicalPath))).toBe(true);
  });

  it("renders decisions and provider-message rehearsal without claiming native compilation", () => {
    render(<ContextCompilerPreview {...baseProps} />);
    const region = screen.getByRole("region", { name: /context compiler preview/i });
    expect(within(region).getByText(/Reference only/i)).toBeInTheDocument();
    expect(within(region).getByText(/product_instruction/i)).toBeInTheDocument();
    expect(within(region).getByText(/No file read/i)).toBeInTheDocument();

    fireEvent.click(within(region).getByRole("tab", { name: /Provider messages/i }));
    expect(within(region).getByLabelText(/Provider message rehearsal/i)).toBeInTheDocument();
    expect(within(region).getByText(/current-request/i)).toBeInTheDocument();
  });

  it("renders an explicit withheld state instead of a budget aggregate for blocked project context", () => {
    render(<ContextCompilerPreview {...baseProps} contextHealth="over-budget" />);
    const region = screen.getByRole("region", { name: /context compiler preview/i });

    expect(within(region).getByRole("alert")).toHaveTextContent(/withheld this preview/i);
    expect(within(region).getByRole("alert")).toHaveTextContent(/native selection or compaction evidence/i);
    expect(within(region).getAllByText("Withheld")).toHaveLength(2);
    expect(within(region).getByText("Aggregate withheld")).toBeInTheDocument();
    expect(within(region).queryByText(/input budget/i)).not.toBeInTheDocument();
  });

  it("filters omitted decisions and switches to a portable markdown export", () => {
    render(<ContextCompilerPreview {...baseProps} budgetTokens={1500} />);
    const region = screen.getByRole("region", { name: /context compiler preview/i });
    fireEvent.change(within(region).getByRole("combobox", { name: /Compiler decision filter/i }), { target: { value: "omitted" } });
    expect(within(region).getByText(/Omitted only/i)).toBeInTheDocument();
    fireEvent.change(within(region).getByRole("combobox", { name: /Context compiler export format/i }), { target: { value: "markdown" } });
    expect(within(region).getByRole("combobox", { name: /Context compiler export format/i })).toHaveValue("markdown");
  });

  it("compares two renderer snapshots without treating the baseline as a native revision", () => {
    const baselineResult = buildContextCompilerReference(baseProps);
    const currentResult = buildContextCompilerReference({ ...baseProps, includeMemories: false });
    expect(baselineResult.compiled).not.toBeNull();
    expect(currentResult.compiled).not.toBeNull();

    const baseline = captureContextCompilerBaseline(baselineResult.compiled!);
    const comparison = compareContextCompilerBaseline(baseline, currentResult.compiled!);
    expect(baseline.schema).toBe("omnia.context-compiler-baseline.preview.v1");
    expect(comparison.consumedTokenDelta).toBeLessThanOrEqual(0);
    expect(comparison.removedCandidates.length).toBeGreaterThan(0);
  });

  it("captures and updates an in-memory baseline from the compare tab", () => {
    const { rerender } = render(<ContextCompilerPreview {...baseProps} />);
    const region = screen.getByRole("region", { name: /context compiler preview/i });

    fireEvent.click(within(region).getByRole("button", { name: /Capture baseline/i }));
    expect(within(region).getByRole("tabpanel", { name: /Compare/i })).toHaveTextContent(/No decision changes|No selection changes/);

    rerender(<ContextCompilerPreview {...baseProps} includeMemories={false} />);
    const comparePanel = within(region).getByRole("tabpanel", { name: /Compare/i });
    expect(comparePanel).toHaveTextContent(/Consumed delta/);
    expect(comparePanel).toHaveTextContent(/Selection changes/);
    expect(comparePanel).toHaveTextContent(/renderer session/i);
  });
});
