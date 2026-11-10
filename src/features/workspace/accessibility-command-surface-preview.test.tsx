import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AccessibilityCommandSurfacePreview from "./accessibility-command-surface-preview";

describe("AccessibilityCommandSurfacePreview", () => {
  it("renders independent comfort controls and a command finder with a clear preview boundary", () => {
    render(<AccessibilityCommandSurfacePreview />);

    expect(screen.getByRole("region", { name: "Accessibility & Command Surface" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Accessibility profile" })).toHaveValue("balanced");
    expect(screen.getByRole("searchbox", { name: "Find a command" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Live interaction sample/i })).toBeInTheDocument();
    expect(screen.getByText(/no OS setting, persisted preference, command dispatch/i)).toBeInTheDocument();
  });

  it("applies an accessibility baseline and allows a custom override", () => {
    render(<AccessibilityCommandSurfacePreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Accessibility profile" }), { target: { value: "low-vision" } });
    expect(screen.getByRole("slider", { name: /Interface text scale/i })).toHaveValue("120");
    expect(screen.getByRole("checkbox", { name: /Strong contrast preview/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /High-visibility focus ring/i })).toBeChecked();
    expect(screen.getByText(/Low vision profile applied/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /Strong contrast preview/i }));
    expect(screen.getByRole("combobox", { name: "Accessibility profile" })).toHaveValue("balanced");
    expect(screen.getByText(/Strong contrast disabled/)).toBeInTheDocument();
  });

  it("filters commands by category and query, then announces local selection", () => {
    render(<AccessibilityCommandSurfacePreview />);
    const commandTabs = screen.getByRole("tablist", { name: "Command categories" });
    fireEvent.click(within(commandTabs).getByRole("tab", { name: "Display" }));

    expect(screen.getByRole("button", { name: /Increase interface text/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start a new Chat/i })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a command" }), { target: { value: "motion" } });
    const action = screen.getByRole("button", { name: /Reduce interface motion/i });
    fireEvent.click(action);
    expect(screen.getByText(/no navigation or native command executed/i)).toBeInTheDocument();
  });

  it("reflects display options in the sample surface and supports an explicit no-results state", () => {
    render(<AccessibilityCommandSurfacePreview />);
    const preview = screen.getByRole("region", { name: /Live interaction sample/i });

    fireEvent.change(screen.getByRole("slider", { name: /Interface text scale/i }), { target: { value: "115" } });
    expect(preview).toHaveStyle({ "--accessibility-text-scale": "115%" });
    fireEvent.click(screen.getByRole("checkbox", { name: /Reduce motion/i }));
    expect(preview).toHaveClass("is-reduced-motion");

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a command" }), { target: { value: "not-a-command" } });
    expect(screen.getByText(/No commands match/)).toBeInTheDocument();
  });
});
