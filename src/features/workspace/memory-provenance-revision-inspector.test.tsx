import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  buildMemoryProvenanceRevisionProjection,
  DEFAULT_MEMORY_PROPOSALS,
  MemoryProvenanceRevisionInspector,
} from "./memory-provenance-revision-inspector";

describe("Memory provenance and revision inspector", () => {
  it("builds deduplicated evidence and conflict metrics from proposal lineage", () => {
    const projection = buildMemoryProvenanceRevisionProjection(DEFAULT_MEMORY_PROPOSALS);

    expect(projection.records).toHaveLength(3);
    expect(projection.evidenceCount).toBe(5);
    expect(projection.runCount).toBe(3);
    expect(projection.conflictCount).toBe(3);
    expect(projection.records[1]?.lineage).toEqual(expect.arrayContaining([
      expect.objectContaining({ revisionId: "memory-renderer-boundary-r1", relation: "contradicts" }),
      expect.objectContaining({ revisionId: "memory-preview-boundary-r1", relation: "duplicate" }),
    ]));
  });

  it("shows provenance details and keeps the renderer boundary explicit", () => {
    render(<MemoryProvenanceRevisionInspector />);

    expect(screen.getByRole("heading", { name: /provenance & revision inspector/i })).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "memory-provenance-tab-provenance");
    expect(screen.getByText(/example references · not verified/i)).toBeInTheDocument();
    expect(screen.getByText(/does not open verified chats/i)).toBeInTheDocument();
    expect(screen.getByText("msg-handoff-042")).toBeInTheDocument();
  });

  it("switches to revision lineage and integrity checks for the selected candidate", () => {
    render(<MemoryProvenanceRevisionInspector />);

    fireEvent.click(screen.getAllByRole("listitem")[1]!);
    fireEvent.click(screen.getByRole("tab", { name: "Revisions" }));
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "memory-provenance-tab-revisions");
    expect(screen.getByRole("list", { name: "Memory revision lineage" })).toHaveTextContent(/Current candidate/i);
    expect(screen.getByText(/Contradicts 1 existing revision/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Integrity" }));
    const checks = screen.getByRole("list", { name: "Provenance integrity checks" });
    expect(within(checks).getByText(/Native provenance receipt/i)).toBeInTheDocument();
    expect(within(checks).getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText(/native evidence resolver is planned/i)).toBeInTheDocument();
  });

  it("filters records without inventing a durable source lookup", () => {
    render(<MemoryProvenanceRevisionInspector />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search provenance records" }), { target: { value: "algorithm" } });
    expect(screen.getByRole("list", { name: "Memory provenance records" })).toHaveTextContent(/Algorithm study routine/i);
    expect(screen.queryByText("Reporting style")).not.toBeInTheDocument();
    expect(screen.getByText(/sample pointers until a native evidence resolver/i)).toBeInTheDocument();
  });
});
