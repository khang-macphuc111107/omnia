import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EffortSelect } from "./effort-select";

describe("EffortSelect", () => {
  it("labels the native select and describes its next-run behavior", () => {
    render(<EffortSelect onChange={vi.fn()} />);
    const select = screen.getByRole("combobox", { name: "Reasoning effort" });
    expect(select.tagName).toBe("SELECT");
    expect(select).toHaveValue("");
    expect(select).toHaveAccessibleDescription("Applies to the next run. Supported levels vary by provider and model.");
    expect(screen.getAllByRole("option").map((option) => option.textContent))
      .toEqual(["Provider default", "low", "medium", "high", "max"]);
  });

  it("emits the chosen level and null for provider default", () => {
    const onChange = vi.fn();
    render(<EffortSelect value="high" onChange={onChange} />);
    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "max" } });
    expect(onChange).toHaveBeenLastCalledWith("max");
    fireEvent.change(select, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("preserves long provider-specific values without duplicating standard levels", () => {
    const value = "provider-specific-effort-".repeat(30);
    const { rerender } = render(<EffortSelect value={value} onChange={vi.fn()} />);
    const select = screen.getByRole("combobox");
    expect(select).toHaveValue(value);
    expect(select.getAttribute("title")).toContain(value);
    expect(screen.getByRole("option", { name: value })).toBeInTheDocument();
    rerender(<EffortSelect value="high" onChange={vi.fn()} />);
    expect(screen.getAllByRole("option", { name: "high" })).toHaveLength(1);
    expect(screen.getAllByRole("option")).toHaveLength(5);
  });

  it("keeps focus and the same native control when a controlled value changes", () => {
    const onChange = vi.fn();
    const { rerender } = render(<EffortSelect value="low" onChange={onChange} />);
    const select = screen.getByRole("combobox");
    select.focus();
    expect(select).toHaveFocus();
    rerender(<EffortSelect value="high" onChange={onChange} />);
    expect(screen.getByRole("combobox")).toBe(select);
    expect(select).toHaveFocus();
    expect(select).toHaveValue("high");
    expect(onChange).not.toHaveBeenCalled();
    expect(select).not.toHaveAttribute("tabindex");
  });

  it("uses native disabled behavior and can be re-enabled", () => {
    const { rerender } = render(<EffortSelect disabled onChange={vi.fn()} />);
    const select = screen.getByRole("combobox");
    expect(select).toBeDisabled();
    select.focus();
    expect(select).not.toHaveFocus();
    rerender(<EffortSelect onChange={vi.fn()} />);
    expect(select).toBeEnabled();
    select.focus();
    expect(select).toHaveFocus();
  });

  it("gives multiple instances independent labels and descriptions", () => {
    render(<><EffortSelect onChange={vi.fn()} /><EffortSelect value="max" onChange={vi.fn()} /></>);
    const selects = screen.getAllByRole("combobox", { name: "Reasoning effort" });
    expect(selects).toHaveLength(2);
    expect(selects[0]!.id).not.toBe(selects[1]!.id);
    expect(selects[0]!.getAttribute("aria-describedby")).not.toBe(selects[1]!.getAttribute("aria-describedby"));
    for (const select of selects) expect(select).toHaveAccessibleDescription(/Applies to the next run/);
  });
});
