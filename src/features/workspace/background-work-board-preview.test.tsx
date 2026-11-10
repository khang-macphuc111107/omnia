import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BackgroundWorkRow } from "./background-work-inspector";
import { BackgroundWorkBoardPreview } from "./background-work-board-preview";

const rows: BackgroundWorkRow[] = [
  {
    id: "queued-1",
    kind: "run",
    name: "Queued research",
    state: "queued",
    summary: "Waiting for a run slot.",
    createdAt: "2026-09-19T08:00:00.000Z",
    stageLabel: "Intake",
  },
  {
    id: "working-1",
    kind: "run",
    name: "Active implementation",
    state: "working",
    summary: "Assistant response is still streaming.",
    createdAt: "2026-09-19T08:01:00.000Z",
    stageLabel: "Writing",
    eventCount: 3,
  },
  {
    id: "attention-1",
    kind: "goal",
    name: "Review blocked run",
    state: "needs-input",
    summary: "Approval is required before continuing.",
    createdAt: "2026-09-19T08:02:00.000Z",
    stageLabel: "Approval",
  },
  {
    id: "done-1",
    kind: "run",
    name: "Completed analysis",
    state: "completed",
    summary: "Run completed with visible evidence.",
    createdAt: "2026-09-19T08:03:00.000Z",
    stageLabel: "Finalization",
  },
];

describe("BackgroundWorkBoardPreview", () => {
  it("renders visible work across stage lanes and exposes truthful preview copy", () => {
    render(<BackgroundWorkBoardPreview rows={rows} />);

    expect(screen.getByRole("heading", { name: "Stage board & flow map" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Board/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "Background work stage board preview" })).toHaveTextContent("Renderer-local topology preview");
    expect(screen.getByRole("status", { name: "Visible background work board summary" })).toHaveTextContent("4 visible");
    expect(screen.getByRole("status", { name: "Visible background work board summary" })).toHaveTextContent("2 active");
    expect(screen.getByRole("region", { name: "Background work stage board preview" })).toHaveTextContent("Queued research");
    expect(screen.getByRole("region", { name: "Background work stage board preview" })).toHaveTextContent("Active implementation");
    expect(screen.getByRole("region", { name: "Background work stage board preview" })).toHaveTextContent("Completed analysis");
  });

  it("switches to a flow map, filters a lane, and reports the selected item", () => {
    const onSelect = vi.fn();
    render(<BackgroundWorkBoardPreview rows={rows} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("tab", { name: /Flow map/i }));
    const initialMap = screen.getByRole("list", { name: "Background work flow map" });
    expect(initialMap).toBeInTheDocument();
    expect(within(initialMap).getAllByText(/visible item/).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByRole("combobox", { name: "Focus lane" }), { target: { value: "attention" } });
    const map = screen.getByRole("list", { name: "Background work flow map" });
    expect(within(map).getByText("Review blocked run")).toBeInTheDocument();
    expect(within(map).queryByText("Queued research")).not.toBeInTheDocument();

    fireEvent.click(within(map).getByRole("button", { name: "Review blocked run" }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "attention-1" }));
    expect(screen.getByRole("complementary", { name: "Selected topology item Review blocked run" })).toHaveTextContent("Needs input");
  });

  it("updates the visible summary and clears a selection hidden by the lane filter", () => {
    render(<BackgroundWorkBoardPreview rows={rows} />);

    fireEvent.click(screen.getByRole("button", { name: /Queued research/i }));
    expect(screen.getByRole("complementary", { name: "Selected topology item Queued research" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Focus lane" }), { target: { value: "attention" } });

    const summary = screen.getByRole("status", { name: "Visible background work board summary" });
    expect(summary).toHaveTextContent("1 visible");
    expect(summary).toHaveTextContent("0 active");
    expect(summary).toHaveTextContent("1 attention");
    expect(screen.queryByRole("complementary", { name: "Selected topology item Queued research" })).not.toBeInTheDocument();
  });

  it("links topology tabs to panels and supports roving keyboard navigation", () => {
    render(<BackgroundWorkBoardPreview rows={rows} />);

    const tablist = screen.getByRole("tablist", { name: "Background work topology view" });
    const boardTab = within(tablist).getByRole("tab", { name: "Board" });
    const mapTab = within(tablist).getByRole("tab", { name: "Flow map" });
    expect(boardTab).toHaveAttribute("aria-controls", "background-work-board-panel-board");
    expect(boardTab).toHaveAttribute("tabindex", "0");
    expect(mapTab).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel", { name: "Board" })).toHaveAttribute("aria-labelledby", boardTab.id);

    boardTab.focus();
    fireEvent.keyDown(boardTab, { key: "ArrowRight" });
    expect(mapTab).toHaveFocus();
    expect(mapTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Flow map" })).toHaveAttribute("aria-labelledby", mapTab.id);
  });
});
