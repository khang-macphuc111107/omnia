import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  serializeWorktreeCoordinationPreview,
  WorktreeCoordinationPreview,
  WORKTREE_COORDINATION_LANES,
} from "./worktree-coordination-preview";

describe("WorktreeCoordinationPreview", () => {
  it("shows proposed lanes without claiming Git or filesystem authority", () => {
    render(<WorktreeCoordinationPreview linkedWorkCount={2} />);

    expect(screen.getByRole("heading", { name: "Worktree coordination" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Worktree coordination lanes" })).toHaveTextContent("UI builder lane");
    expect(screen.getByRole("region", { name: "Worktree coordination preview" })).toHaveTextContent("Renderer-local worktree coordination preview");
    expect(screen.getByRole("region", { name: "Worktree coordination preview" })).toHaveTextContent("2 background items");
    expect(screen.getByRole("region", { name: "Worktree coordination preview" })).toHaveTextContent("does not read or write the filesystem");
  });

  it("filters attention lanes and keeps actions renderer-local", () => {
    render(<WorktreeCoordinationPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Worktree coordination focus" }), { target: { value: "attention" } });
    const laneList = screen.getByRole("list", { name: "Worktree coordination lanes" });
    expect(within(laneList).getByRole("button", { name: /Project Twin lane\. Conflict held/i })).toBeInTheDocument();
    expect(within(laneList).queryByRole("button", { name: /UI builder lane/i })).not.toBeInTheDocument();

    fireEvent.click(within(laneList).getByRole("button", { name: /Project Twin lane/i }));
    const detail = screen.getByRole("complementary", { name: "Selected worktree lane" });
    fireEvent.click(within(detail).getByRole("button", { name: /Compare claims/i }));
    expect(screen.getByRole("status")).toHaveTextContent("no native Git, filesystem, lease, or merge mutation");
  });

  it("surfaces overlapping path claims and a non-executing plan", () => {
    render(<WorktreeCoordinationPreview />);

    fireEvent.click(screen.getByRole("tab", { name: /Claims/i }));
    expect(screen.getByRole("tabpanel", { name: /Claims/i })).toHaveTextContent("Shared writes stay held");
    expect(screen.getByRole("list", { name: "Worktree path claim ledger" })).toHaveTextContent("source-ledger.json");
    expect(screen.getByRole("list", { name: "Worktree path claim ledger" })).toHaveTextContent("conflict gate");

    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(screen.getByRole("tabpanel", { name: "Plan" })).toHaveTextContent("No native execution");
    expect(screen.getByRole("tabpanel", { name: "Plan" })).toHaveTextContent("Require a native worktree");
  });

  it("supports roving tab navigation and portable JSON/Markdown previews", () => {
    render(<WorktreeCoordinationPreview />);

    const tablist = screen.getByRole("tablist", { name: "Worktree coordination view" });
    const lanesTab = within(tablist).getByRole("tab", { name: "Lanes" });
    const claimsTab = within(tablist).getByRole("tab", { name: /Claims/i });
    lanesTab.focus();
    fireEvent.keyDown(lanesTab, { key: "ArrowRight" });
    expect(claimsTab).toHaveFocus();
    expect(claimsTab).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    const exportRegion = screen.getByRole("region", { name: "Worktree coordination export preview" });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent("omnia.worktree-coordination-preview.v1");
    fireEvent.change(within(exportRegion).getByRole("combobox", { name: "Worktree coordination export format" }), { target: { value: "markdown" } });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent("# Omnia worktree coordination preview");
  });

  it("serializes the bounded lane fixture without native receipts", () => {
    const json = serializeWorktreeCoordinationPreview(WORKTREE_COORDINATION_LANES, "json");
    const parsed = JSON.parse(json) as { schema: string; executionDisposition: string; durableWrite: boolean; nativeBranchEvidence: boolean; lanes: unknown[] };
    expect(parsed.schema).toBe("omnia.worktree-coordination-preview.v1");
    expect(parsed.executionDisposition).toBe("preview-only");
    expect(parsed.durableWrite).toBe(false);
    expect(parsed.nativeBranchEvidence).toBe(false);
    expect(parsed.lanes).toHaveLength(4);
    expect(serializeWorktreeCoordinationPreview(WORKTREE_COORDINATION_LANES, "markdown")).toContain("Proposed branch labels");
  });
});
