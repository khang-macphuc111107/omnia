import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import MemoryScreen from "./activities/memory-screen";
import MemoryProposalInbox, { DEFAULT_MEMORY_PROPOSALS } from "./memory-proposal-inbox";

describe("Memory proposal inbox preview", () => {
  it("keeps evidence, revision lineage, and preview-only boundary visible", () => {
    render(<MemoryProposalInbox />);

    expect(screen.getByRole("region", { name: "Memory proposal inbox" })).toHaveTextContent(/renderer-local review queue/i);
    expect(screen.getByText(/msg-handoff-042/)).toBeInTheDocument();
    expect(screen.getByText(/memory-report-style-r3/)).toBeInTheDocument();
    expect(screen.getByText(/does not promote a revision, mutate durable memory/i)).toBeInTheDocument();
  });

  it("supports renderer-local approve, reject, and return-to-pending decisions", () => {
    render(<MemoryProposalInbox />);

    fireEvent.click(screen.getByRole("button", { name: /approve preview/i }));
    expect(screen.getByRole("status", { name: "Memory proposal counts" })).toHaveTextContent(/1 approved preview/);
    expect(screen.getByText(/approved “reporting style” in this renderer preview only/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /return to pending/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /return to pending/i }));
    expect(screen.getByRole("status", { name: "Memory proposal counts" })).toHaveTextContent(/3 pending/);

    fireEvent.change(screen.getByRole("combobox", { name: "Memory proposal decision filter" }), { target: { value: "all" } });
    fireEvent.click(screen.getByRole("button", { name: /algorithm study routine/i }));
    fireEvent.click(screen.getByRole("button", { name: /reject preview/i }));
    expect(screen.getByText(/rejected “algorithm study routine” in this renderer preview only/i)).toBeInTheDocument();
  });

  it("exposes contradiction and duplicate signals for review-risk proposals", () => {
    render(<MemoryProposalInbox />);

    fireEvent.click(screen.getByRole("button", { name: /preview truthfulness/i }));
    const detail = screen.getByRole("complementary", { name: "Selected memory proposal details" });
    expect(detail).toHaveTextContent(/contradicts 1 existing revision/i);
    expect(detail).toHaveTextContent(/looks similar to 1 revision/i);
    expect(within(detail).getByText(/memory-renderer-boundary-r1/)).toBeInTheDocument();
  });

  it("filters by risk and searches revision identifiers", () => {
    render(<MemoryProposalInbox />);

    fireEvent.change(screen.getByRole("combobox", { name: "Memory proposal risk filter" }), { target: { value: "sensitive" } });
    expect(screen.getByRole("list", { name: "Memory proposals" })).toHaveTextContent(/algorithm study routine/i);
    expect(screen.getByRole("list", { name: "Memory proposals" })).not.toHaveTextContent(/reporting style/i);

    fireEvent.change(screen.getByRole("combobox", { name: "Memory proposal risk filter" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Search memory proposals" }), { target: { value: "memory-renderer-boundary-r2" } });
    expect(screen.getByRole("list", { name: "Memory proposals" })).toHaveTextContent(/preview truthfulness/i);
    expect(screen.getByRole("list", { name: "Memory proposals" })).not.toHaveTextContent(/algorithm study routine/i);
  });

  it("resets preview decisions without mutating the provided proposal records", () => {
    const proposalsBefore = DEFAULT_MEMORY_PROPOSALS;
    render(<MemoryProposalInbox proposals={proposalsBefore} />);

    fireEvent.click(screen.getByRole("button", { name: /approve preview/i }));
    fireEvent.click(screen.getByRole("button", { name: /reset decisions/i }));
    expect(screen.getByRole("status", { name: "Memory proposal counts" })).toHaveTextContent(/3 pending/);
    expect(proposalsBefore[0]?.decision).toBe("pending");
  });

  it("supports undo and redo for renderer-local decisions and reset", () => {
    render(<MemoryProposalInbox />);

    fireEvent.click(screen.getByRole("button", { name: /approve preview/i }));
    expect(screen.getByRole("status", { name: "Memory proposal counts" })).toHaveTextContent(/1 approved preview/);

    fireEvent.click(screen.getByRole("button", { name: "Undo last proposal decision" }));
    expect(screen.getByRole("status", { name: "Memory proposal counts" })).toHaveTextContent(/3 pending/);
    expect(screen.getByRole("button", { name: "Redo last proposal decision" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Redo last proposal decision" }));
    expect(screen.getByRole("status", { name: "Memory proposal counts" })).toHaveTextContent(/1 approved preview/);

    fireEvent.click(screen.getByRole("button", { name: /reset decisions/i }));
    expect(screen.getByRole("status", { name: "Memory proposal counts" })).toHaveTextContent(/3 pending/);
    fireEvent.click(screen.getByRole("button", { name: "Undo last proposal decision" }));
    expect(screen.getByRole("status", { name: "Memory proposal counts" })).toHaveTextContent(/1 approved preview/);
  });

  it("supports renderer-local bulk decisions for the visible filter result", () => {
    render(<MemoryProposalInbox />);

    fireEvent.click(screen.getByRole("button", { name: "Approve visible proposals" }));
    expect(screen.getByRole("status", { name: "Memory proposal counts" })).toHaveTextContent(/3 approved preview/);
    expect(screen.getByText(/approved 3 visible proposals in this renderer preview only/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("combobox", { name: "Memory proposal decision filter" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Memory proposal decision filter" }), { target: { value: "all" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject visible proposals" }));
    expect(screen.getByRole("status", { name: "Memory proposal counts" })).toHaveTextContent(/3 rejected preview/);
  });

  it("mounts from the Memory Studio Proposals tab without changing the existing entries route", async () => {
    render(<MemoryScreen />);

    fireEvent.click(screen.getByRole("tab", { name: "Proposals" }));
    expect(await screen.findByRole("region", { name: "Memory proposal inbox" })).toBeInTheDocument();
    expect(screen.getByText(/renderer-local review queue/i)).toBeInTheDocument();
  });
});
