import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { initialProviders } from "./mock-data";
import SettingsProviderSurface from "./settings-provider-surface";

describe("SettingsProviderSurface disclosure controls", () => {
  it("makes each advanced workbench disclosure visibly openable", () => {
    render(
      <SettingsProviderSurface
        providers={initialProviders}
        modelProfileId="auto"
        onModelProfileChange={vi.fn()}
      />,
    );

    const routingLabel = screen.getByText("Routing workbench", { selector: "strong" });
    const summary = routingLabel.closest("summary");
    expect(summary).not.toBeNull();
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(summary).toHaveAttribute("title", "Open Routing workbench");

    fireEvent.click(summary!);

    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(summary).toHaveAttribute("title", "Collapse Routing workbench");
    const bodyId = summary?.getAttribute("aria-controls");
    expect(bodyId).toBeTruthy();
    const body = document.getElementById(bodyId!);
    expect(body).toBeInTheDocument();
    expect(body).not.toBeEmptyDOMElement();

    fireEvent.click(summary!);
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(summary).toHaveAttribute("title", "Open Routing workbench");
  });
});
