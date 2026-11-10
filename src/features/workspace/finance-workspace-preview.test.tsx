import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import FinanceWorkspacePreview from "./finance-workspace-preview";

describe("FinanceWorkspacePreview", () => {
  it("renders a bounded budget posture and local-only boundary", () => {
    render(<FinanceWorkspacePreview />);

    expect(screen.getByRole("heading", { name: "Finance Workspace" })).toBeInTheDocument();
    expect(screen.getByText("Preview only")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /finance budget ledger/i })).toBeInTheDocument();
    expect(screen.getByText(/no account sync, transaction import, market quote/i)).toBeInTheDocument();
    expect(screen.getByText("actual monthly net").closest("strong")).toHaveTextContent("$1410.00");
  });

  it("updates the ledger and posture when a local actual changes", () => {
    render(<FinanceWorkspacePreview />);
    fireEvent.change(screen.getByLabelText("Transport actual amount"), { target: { value: "500" } });

    expect(screen.getByText("actual monthly net").closest("strong")).toHaveTextContent("$1320.00");
    screen.getByRole("region", { name: /finance budget ledger/i });
    expect(within(screen.getByRole("row", { name: /Transport/ })).getByText("Over plan")).toBeInTheDocument();
  });

  it("switches scenarios and includes the selected plan in markdown export", () => {
    render(<FinanceWorkspacePreview />);
    fireEvent.click(screen.getByRole("tab", { name: /lean plan/i }));

    expect(screen.getByRole("tab", { name: /lean plan/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: /Lean plan/i })).toBeInTheDocument();

    const exportRegion = screen.getByRole("region", { name: /finance workspace export preview/i });
    fireEvent.change(within(exportRegion).getByLabelText(/finance export format/i), { target: { value: "markdown" } });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/Omnia finance workspace preview/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/Lean plan/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/Renderer-local planning preview/);
  });

  it("fails closed for malformed inputs and can reset the session preview", () => {
    render(<FinanceWorkspacePreview />);
    fireEvent.change(screen.getByLabelText("Monthly income"), { target: { value: "not-a-number" } });
    expect(screen.getByRole("status", { name: /finance workspace input review/i })).toHaveTextContent(/finite number/i);
    expect(screen.getByText("actual monthly net").closest("strong")).toHaveTextContent("Unavailable");

    fireEvent.click(screen.getByRole("button", { name: /reset/i }));
    expect(screen.getByLabelText("Monthly income")).toHaveValue("5200");
    expect(screen.getByText("actual monthly net").closest("strong")).toHaveTextContent("$1410.00");
  });
});
