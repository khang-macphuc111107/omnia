import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import MemoryScreen from "./activities/memory-screen";
import {
  buildMemoryLifecycleProjection,
  DEFAULT_MEMORY_LIFECYCLE_RECORDS,
  MemoryLifecycleStudio,
} from "./memory-lifecycle-studio";

describe("Memory lifecycle studio preview", () => {
  it("summarizes revision, retention, evidence, and consolidation signals from fixtures", () => {
    const projection = buildMemoryLifecycleProjection(DEFAULT_MEMORY_LIFECYCLE_RECORDS);

    expect(projection.metrics).toEqual({
      total: 4,
      active: 3,
      attention: 3,
      terminal: 1,
      evidenceCount: 11,
      supersessionCount: 1,
      consolidationCandidates: 3,
    });
  });

  it("shows ordered lifecycle evidence and states that it is not a native journal", () => {
    render(<MemoryLifecycleStudio />);

    expect(screen.getByRole("region", { name: "Memory lifecycle studio" })).toHaveTextContent(/ordered lifecycle workbench/i);
    expect(screen.getByRole("list", { name: "Memory lifecycle records" })).toHaveTextContent(/Reporting style/i);
    const timeline = screen.getByRole("region", { name: "Memory lifecycle timeline" });
    expect(timeline).toHaveTextContent(/Candidate proposed/i);
    expect(timeline).toHaveTextContent(/Review checks passed/i);
    expect(timeline).toHaveTextContent(/Retrieval rehearsal/i);
    expect(screen.getByText(/no native journal is queried/i)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/preview only · renderer-local · no durable write/i);
  });

  it("filters by stage and scope, while preserving visible fixture counts", () => {
    render(<MemoryLifecycleStudio />);

    fireEvent.change(screen.getByRole("combobox", { name: "Memory lifecycle scope filter" }), { target: { value: "Project · Omnia" } });
    expect(screen.getByRole("list", { name: "Memory lifecycle records" })).toHaveTextContent(/Preview truthfulness/i);
    expect(screen.getByRole("list", { name: "Memory lifecycle records" })).not.toHaveTextContent(/Reporting style/i);

    fireEvent.change(screen.getByRole("combobox", { name: "Memory lifecycle stage filter" }), { target: { value: "revised" } });
    expect(screen.getByRole("status", { name: "Visible lifecycle records" })).toHaveTextContent("1 visible");
    expect(screen.getByRole("list", { name: "Memory lifecycle records" })).toHaveTextContent(/Preview truthfulness/i);

    fireEvent.change(screen.getByRole("combobox", { name: "Memory lifecycle scope filter" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Memory lifecycle stage filter" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Search memory lifecycle records" }), { target: { value: "memory-study-routine-r0" } });
    expect(screen.getByRole("list", { name: "Memory lifecycle records" })).toHaveTextContent(/Algorithm study routine · legacy/i);
    expect(screen.getByRole("list", { name: "Memory lifecycle records" })).not.toHaveTextContent(/Reporting style/i);
  });

  it("advances and restores only the selected stage preview", () => {
    render(<MemoryLifecycleStudio />);

    const records = screen.getByRole("list", { name: "Memory lifecycle records" });
    fireEvent.click(within(records).getByRole("button", { name: /Reporting style/i }));
    expect(screen.getByRole("complementary", { name: "Selected memory lifecycle details" })).toHaveTextContent("Retrieved");

    fireEvent.click(screen.getByRole("button", { name: /advance stage preview/i }));
    expect(screen.getByRole("complementary", { name: "Selected memory lifecycle details" })).toHaveTextContent("Revised");
    expect(screen.getByRole("status", { name: "Memory lifecycle preview state" })).toHaveTextContent(/advanced to revised in this renderer preview only/i);

    fireEvent.click(screen.getByRole("button", { name: /restore fixture stage/i }));
    expect(screen.getByRole("complementary", { name: "Selected memory lifecycle details" })).toHaveTextContent("Retrieved");
    expect(screen.getByRole("status", { name: "Memory lifecycle preview state" })).toHaveTextContent(/returned to its fixture stage/i);
  });

  it("mounts as a lazy dedicated Memory Studio tab", async () => {
    render(<MemoryScreen />);

    fireEvent.click(screen.getByRole("tab", { name: "Lifecycle" }));
    expect(await screen.findByRole("region", { name: "Memory lifecycle studio" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Entries" })).toHaveAttribute("aria-controls", "memory-studio-panel-entries");
  });
});
