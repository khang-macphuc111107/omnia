import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReferenceWorkbench } from "./reference-workbench";

describe("ReferenceWorkbench", () => {
  it("shows pinned cycle 10 decisions and lets the selected observation close", () => {
    render(<ReferenceWorkbench />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search observations" }), { target: { value: "NorthCUA" } });
    fireEvent.click(screen.getByRole("button", { name: /NorthCUA/ }));
    expect(screen.getByText("3a84026a1affa77f3ffeca9c58012eabf6824733")).toBeInTheDocument();
    expect(screen.getAllByText(/reconcile.*unknown/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Close observation" }));
    expect(screen.queryByRole("complementary", { name: "Selected research observation" })).not.toBeInTheDocument();
  });
  it("exposes research observations as semantic list items with selectable controls", () => {
    render(<ReferenceWorkbench />);
    const list = screen.getByRole("list", { name: "Reviewed observations" });
    const items = within(list).getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(within(item).getByRole("button")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search observations" }), { target: { value: "no-matching-research" } });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
  });
  it("renders reviewed observations and an explicit synthesis decision", () => {
    render(<ReferenceWorkbench />);
    expect(screen.getByRole("heading", { name: "Reference workbench" })).toBeInTheDocument();
    expect(screen.getAllByText("Codex session continuity").length).toBeGreaterThan(0);
    expect(screen.getByText("Omnia decision")).toBeInTheDocument();
    expect(screen.getByText(/Represent a session as durable state/)).toBeInTheDocument();
  });

  it("filters by area and searches without losing provenance", () => {
    render(<ReferenceWorkbench />);
    fireEvent.click(screen.getByRole("button", { name: /Browser harness/ }));
    expect(screen.getByText("Chrome CDP tab protocol")).toBeInTheDocument();
    expect(screen.queryByText("Codex session continuity")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search observations" }), { target: { value: "stale" } });
    fireEvent.click(screen.getByRole("button", { name: /Chrome CDP tab protocol/ }));
    expect(screen.getByText(/Tab switch, navigation, release/)).toBeInTheDocument();
    expect(screen.getByText("browser/chrome-canary/src/cdp-client.ts")).toBeInTheDocument();
  });

  it("supports keyboard-usable row selection and held-out filtering", () => {
    render(<ReferenceWorkbench />);
    const row = screen.getByRole("button", { name: /Assistant UI primitive model/ });
    row.focus();
    expect(row).toHaveFocus();
    fireEvent.click(row);
    expect(screen.getByText(/Use the interaction taxonomy only/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Hide held-out references"));
    expect(screen.queryByText("Assistant UI primitive model")).not.toBeInTheDocument();
  });

  it("clears an unmatched search", () => {
    render(<ReferenceWorkbench />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search observations" }), { target: { value: "does-not-exist" } });
    expect(screen.getByText("No observed contract matches this filter.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getAllByText("Codex session continuity").length).toBeGreaterThan(0);
  });
});
