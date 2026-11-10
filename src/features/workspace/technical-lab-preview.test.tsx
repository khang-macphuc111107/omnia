import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import TechnicalLabPreview from "./technical-lab-preview";

describe("TechnicalLabPreview", () => {
  it("switches domains and computes deterministic preview values", () => {
    render(<TechnicalLabPreview />);
    expect(screen.getByText("3", { selector: ".technical-lab__value" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /physics/i }));
    expect(screen.getByRole("heading", { name: /Kinetic energy/i })).toBeInTheDocument();
    expect(screen.getByText(/144\.0000/, { selector: ".technical-lab__value" })).toBeInTheDocument();
  });

  it("records a local result and exposes an export preview", () => {
    render(<TechnicalLabPreview />);
    fireEvent.click(screen.getByRole("button", { name: /recalculate preview/i }));
    expect(screen.getByText(/Recent calculations/i)).toBeInTheDocument();
    const exportRegion = screen.getByRole("region", { name: /technical lab export preview/i });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/omnia\.technical-lab\.preview\.v1/);
    fireEvent.change(within(exportRegion).getByLabelText(/format/i), { target: { value: "markdown" } });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/Renderer-local preview/i);
  });

  it("links domain tabs to the active workbench and supports roving keyboard navigation", () => {
    render(<TechnicalLabPreview />);

    const tablist = screen.getByRole("tablist", { name: "Technical lab domains" });
    const mathTab = within(tablist).getByRole("tab", { name: "Math" });
    const physicsTab = within(tablist).getByRole("tab", { name: "Physics" });
    expect(mathTab).toHaveAttribute("aria-controls", "technical-lab-panel-math");
    expect(mathTab).toHaveAttribute("tabindex", "0");
    expect(physicsTab).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel", { name: "Math" })).toHaveAttribute("aria-labelledby", mathTab.id);

    mathTab.focus();
    fireEvent.keyDown(mathTab, { key: "ArrowRight" });
    expect(physicsTab).toHaveFocus();
    expect(physicsTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Physics" })).toHaveAttribute("aria-labelledby", physicsTab.id);
  });

  it("offers finance scenario presets and compares deterministic models", () => {
    render(<TechnicalLabPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /finance/i }));

    const comparison = screen.getByRole("region", { name: /finance scenario comparison/i });
    expect(within(comparison).getByRole("button", { name: /loan amortization/i })).toBeInTheDocument();
    expect(within(comparison).getByRole("button", { name: /discounted cash flow/i })).toBeInTheDocument();

    fireEvent.click(within(comparison).getByRole("button", { name: /loan amortization/i }));
    expect(screen.getByRole("heading", { name: /loan amortization scenario/i })).toBeInTheDocument();
    expect(within(screen.getByRole("complementary")).getByText(/currency \/ period/)).toBeInTheDocument();

    fireEvent.click(within(comparison).getByRole("button", { name: /discounted cash flow/i }));
    expect(screen.getByRole("heading", { name: /discounted cash-flow scenario/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/cash flow per period/i)).toHaveValue("400");
    expect(screen.getByRole("table", { name: /finance sensitivity preview/i })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /5%/i })).toBeInTheDocument();
  });

  it("includes finance comparison data in JSON and markdown previews", () => {
    render(<TechnicalLabPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /finance/i }));
    const exportRegion = screen.getByRole("region", { name: /technical lab export preview/i });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/comparisons/);

    fireEvent.change(within(exportRegion).getByLabelText(/format/i), { target: { value: "markdown" } });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/Finance scenario comparison/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/Loan amortization/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/Finance sensitivity/);
  });

  it("shows local input review warnings without hiding the preview result", () => {
    render(<TechnicalLabPreview />);
    const coefficient = screen.getByLabelText("Coefficient a");
    fireEvent.change(coefficient, { target: { value: "0" } });
    const review = screen.getByRole("status", { name: /technical lab input review/i });
    expect(within(review).getByText(/coefficient a is zero/i)).toBeInTheDocument();
    expect(screen.getByText("Undefined", { selector: ".technical-lab__value" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /finance/i }));
    fireEvent.change(screen.getByLabelText("Annual rate"), { target: { value: "-100" } });
    expect(screen.getByRole("status", { name: /technical lab input review/i })).toHaveTextContent(/above -100%/i);
  });

  it("fails closed for malformed numeric input instead of calculating from zero", () => {
    render(<TechnicalLabPreview />);
    fireEvent.change(screen.getByLabelText("Coefficient a"), { target: { value: "not-a-number" } });

    expect(screen.getByText("Unavailable", { selector: ".technical-lab__value" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /technical lab input review/i })).toHaveTextContent(/finite number/i);

    fireEvent.click(screen.getByRole("button", { name: /recalculate preview/i }));
    expect(screen.getByRole("region", { name: /technical lab history/i })).toHaveTextContent(/no calculations recorded yet/i);
  });

  it("restores the domain and inputs represented by a session history entry", () => {
    render(<TechnicalLabPreview />);
    fireEvent.change(screen.getByLabelText("Coefficient a"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Constant b"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /recalculate preview/i }));
    fireEvent.click(screen.getByRole("tab", { name: /physics/i }));

    fireEvent.click(screen.getByRole("button", { name: /restore linear root from math history/i }));

    expect(screen.getByRole("tab", { name: "Math" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Coefficient a")).toHaveValue("2");
    expect(screen.getByLabelText("Constant b")).toHaveValue("10");
    expect(screen.getByText("-5", { selector: ".technical-lab__value" })).toBeInTheDocument();
  });

  it("normalizes selectable science units before calculating", () => {
    render(<TechnicalLabPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /physics/i }));
    fireEvent.change(screen.getByLabelText("Mass value"), { target: { value: "2000" } });
    fireEvent.change(screen.getByLabelText("Mass unit"), { target: { value: "g" } });
    fireEvent.change(screen.getByLabelText("Velocity value"), { target: { value: "43.2" } });
    fireEvent.change(screen.getByLabelText("Velocity unit"), { target: { value: "km/h" } });
    expect(screen.getByText(/144\.0000/, { selector: ".technical-lab__value" })).toBeInTheDocument();
    expect(screen.getByText(/normalized to kg/i, { selector: ".technical-lab__assumptions span" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /chemistry/i }));
    fireEvent.change(screen.getByLabelText("Volume value"), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText("Volume unit"), { target: { value: "mL" } });
    expect(screen.getByText(/1\.000000/, { selector: ".technical-lab__value" })).toBeInTheDocument();
  });
});
