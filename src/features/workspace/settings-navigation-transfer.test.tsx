import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import SettingsNavigationTransfer, {
  SETTINGS_NAVIGATION_PROFILE_SCHEMA,
  buildSettingsNavigationProfilePayload,
} from "./settings-navigation-transfer";

const items = [
  { id: "appearance", label: "Appearance", description: "Theme and motion" },
  { id: "providers", label: "Providers", description: "Models and endpoints" },
  { id: "diagnostics", label: "Diagnostics", description: "Logs and exports" },
] as const;

describe("SettingsNavigationTransfer", () => {
  it("pins sections, changes the default, and supports undo", () => {
    const onSelect = vi.fn();
    render(<SettingsNavigationTransfer items={items} activeId="providers" onSelect={onSelect} />);

    expect(screen.getByRole("heading", { name: "Settings navigation & portability" })).toBeInTheDocument();
    const appearance = screen.getByRole("checkbox", { name: /Appearance Theme and motion/i });
    expect(screen.getByRole("button", { name: "Appearance" })).toBeInTheDocument();
    fireEvent.click(appearance);
    expect(screen.queryByRole("button", { name: "Appearance" })).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: /Default opening section/i }), { target: { value: "diagnostics" } });
    fireEvent.click(screen.getByRole("button", { name: "Open default" }));
    expect(onSelect).toHaveBeenCalledWith("diagnostics");

    fireEvent.click(screen.getByRole("button", { name: "Undo navigation change" }));
    expect(screen.getByRole("combobox", { name: /Default opening section/i })).toHaveValue("providers");
  });

  it("stages a valid renderer-local profile import and rejects unsupported data", () => {
    const onSelect = vi.fn();
    render(<SettingsNavigationTransfer items={items} activeId="appearance" onSelect={onSelect} />);

    const payload = buildSettingsNavigationProfilePayload(
      "Imported map",
      "A portable preview map.",
      { defaultCategory: "diagnostics", pinnedCategoryIds: ["diagnostics"] },
    );
    expect(JSON.parse(payload).schema).toBe(SETTINGS_NAVIGATION_PROFILE_SCHEMA);
    fireEvent.change(screen.getByLabelText("Paste a profile to stage"), { target: { value: payload } });
    expect(screen.getByText(/Ready to import “Imported map”/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Apply imported map/i }));
    expect(onSelect).toHaveBeenCalledWith("diagnostics");

    fireEvent.change(screen.getByLabelText("Paste a profile to stage"), { target: { value: "{not json" } });
    expect(screen.getAllByRole("status").some((element) => /not valid JSON/i.test(element.textContent ?? ""))).toBe(true);
  });

  it("keeps the compact map collapsed until Customize is requested", () => {
    render(<SettingsNavigationTransfer items={items} activeId="providers" onSelect={vi.fn()} compact />);

    expect(screen.getByRole("button", { name: "Customize map" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Choose pinned sections" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Customize map" }));
    expect(screen.getByRole("heading", { name: "Choose pinned sections" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide map" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide map" }));
    expect(screen.queryByRole("heading", { name: "Choose pinned sections" })).not.toBeInTheDocument();
  });

  it("uses a labeled compact jump field instead of a long pinned-chip rail", () => {
    const onSelect = vi.fn();
    render(<SettingsNavigationTransfer items={items} activeId="providers" onSelect={onSelect} compact />);

    const quickJump = screen.getByRole("combobox", { name: "Jump to a settings section" });
    expect(quickJump).toHaveValue("providers");
    expect(screen.getByRole("toolbar", { name: "Quick settings navigation" })).toContainElement(quickJump);

    fireEvent.change(quickJump, { target: { value: "diagnostics" } });
    expect(onSelect).toHaveBeenCalledWith("diagnostics");
  });
});
