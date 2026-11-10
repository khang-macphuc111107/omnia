import { render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { OmniaLogo } from "@/components/omnia-logo";

import { ContextInspectorPanel } from "./inspector";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

afterEach(() => {
  useWorkspaceStore.setState(initialState, true);
  document.body.innerHTML = "";
});

describe("UI system accessibility contracts", () => {
  it("renders the product mark without SVG paint-server collisions", () => {
    const { container } = render(
      <>
        <OmniaLogo />
        <OmniaLogo compact variant="hex-core" />
      </>,
    );

    expect(container.querySelectorAll("linearGradient, radialGradient")).toHaveLength(0);
    expect(container.querySelectorAll(".omnia-logo__aperture")).toHaveLength(2);
    expect(container.querySelectorAll(".omnia-logo--command-ring")).toHaveLength(1);
  });

  it("exposes a complete roving-tab inspector tab contract", () => {
    useWorkspaceStore.setState({ inspectorOpen: true, inspectorTab: "context" });

    const { getByRole } = render(<ContextInspectorPanel />);
    const inspector = getByRole("complementary", { name: "Context and run inspector" });
    const tablist = within(inspector).getByRole("tablist", { name: "Inspector view" });
    const tabs = [...tablist.querySelectorAll<HTMLElement>('[role="tab"]')];

    expect(tabs).toHaveLength(3);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);

    const activeTab = tabs[0];
    expect(activeTab).toBeDefined();
    expect(within(inspector).getByRole("tabpanel", { name: "Context" })).toHaveAttribute(
      "id",
      activeTab?.getAttribute("aria-controls"),
    );
    expect(within(inspector).getByRole("tabpanel", { name: "Context" })).toHaveAttribute("aria-labelledby", activeTab?.id);
  });
});
