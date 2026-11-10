import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import MemoryScreen from "./activities/memory-screen";
import MemoryReviewWorkbench, { DEFAULT_MEMORY_REVIEW_ITEMS } from "./memory-review-workbench";

describe("Memory review cockpit preview", () => {
  it("prioritizes blockers and keeps the local review boundary visible", () => {
    render(<MemoryReviewWorkbench />);

    const region = screen.getByRole("region", { name: "Memory review cockpit" });
    expect(region).toHaveTextContent(/triage and evidence cockpit/i);
    expect(region).toHaveTextContent(/preview only/i);
    expect(region).toHaveTextContent(/preview truthfulness/i);
    expect(region).toHaveTextContent(/queue state, checklist changes, notes, and stage labels are renderer-session only/i);
  });

  it("supports gate completion, ready staging, snooze, and reset without mutating seed records", () => {
    render(<MemoryReviewWorkbench items={DEFAULT_MEMORY_REVIEW_ITEMS} />);

    fireEvent.click(screen.getByRole("button", { name: /preview truthfulness/i }));
    const detail = screen.getByRole("complementary", { name: "Selected memory review candidate" });
    const gates = within(detail).getByRole("group", { name: "Memory review gates" });
    const unchecked = within(gates).getAllByRole("checkbox").filter((checkbox) => !(checkbox as HTMLInputElement).checked);
    unchecked.forEach((checkbox) => fireEvent.click(checkbox));
    expect(within(detail).getByText("Ready")).toBeInTheDocument();

    fireEvent.click(within(detail).getByRole("button", { name: /mark ready preview/i }));
    expect(within(detail).getByText("Ready preview")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Memory review queue counts" })).toHaveTextContent(/2\s*ready preview/);

    fireEvent.click(within(detail).getByRole("button", { name: /snooze/i }));
    expect(within(detail).getByText("Snoozed")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Memory review queue counts" })).toHaveTextContent(/1\s*snoozed/);

    fireEvent.click(screen.getByRole("button", { name: /reset queue/i }));
    expect(screen.getByRole("status", { name: "Memory review queue counts" })).toHaveTextContent(/1\s*ready preview/);
    expect(DEFAULT_MEMORY_REVIEW_ITEMS[0]?.checks.lineage).toBe(false);
  });

  it("mounts in the Memory Studio proposals tab as a lazy renderer surface", async () => {
    render(<MemoryScreen />);

    fireEvent.click(screen.getByRole("tab", { name: "Proposals" }));
    expect(await screen.findByRole("region", { name: "Memory review cockpit" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Memory review cockpit" })).toHaveTextContent(/native memory bridge is connected/i);
  });
});
