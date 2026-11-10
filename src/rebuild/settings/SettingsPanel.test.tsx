import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import { rebuildSettingsStore } from "./settings";

describe("SettingsPanel", () => {
  beforeEach(() => { rebuildSettingsStore.reset(); });

  it("exposes labelled advanced controls and applies a setting without closing", () => {
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Advanced runtime" })).toBeInTheDocument();
    const context = screen.getByLabelText("Compact context tokens");
    fireEvent.change(context, { target: { value: "220000" } });
    expect(rebuildSettingsStore.get().context.compactTokens).toBe(220_000);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows permission controls only after selecting the Privacy tab", () => {
    render(<SettingsPanel onClose={() => undefined} />);
    expect(screen.queryByLabelText("Allow OS automation")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));
    expect(screen.getByLabelText("Allow OS automation")).toBeInTheDocument();
  });

  it("keeps every settings section represented by an accessible tab", () => {
    render(<SettingsPanel onClose={() => undefined} />);
    expect(screen.getByRole("tablist", { name: "Settings sections" })).toHaveAttribute("aria-orientation", "horizontal");
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(5);
    for (const tab of tabs) expect(tab).toHaveAttribute("aria-controls", expect.stringMatching(/^settings-panel-/));
  });

  it("uses roving tab focus and exposes the active panel relationship", () => {
    render(<SettingsPanel onClose={() => undefined} />);
    const runtimeTab = screen.getByRole("tab", { name: "Runtime" });
    const workflowTab = screen.getByRole("tab", { name: "Workflow" });
    expect(runtimeTab).toHaveAttribute("tabindex", "0");
    expect(workflowTab).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(runtimeTab, { key: "ArrowRight" });
    expect(workflowTab).toHaveFocus();
    expect(workflowTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", workflowTab.id);
    fireEvent.keyDown(workflowTab, { key: "Home" });
    expect(runtimeTab).toHaveFocus();
  });
});

